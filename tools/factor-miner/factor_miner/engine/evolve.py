"""进化主循环（遗传规划引擎）。

流程：
  初始化种群(ramped half-and-half)
    → 并行/向量化评估适应度(含复杂度惩罚；相关性惩罚对齐精英池)
    → 验证集上评估精英，记录 val_fitness 轨迹
    → 验证集适应度衰减早停(patience + min_delta)
    → 多样性控制(表达式去重)
    → 检查点保存(可断点恢复)
    → 选择(锦标赛+精英) → 交叉 + 变异 → 新种群
  输出最优因子 + 每代统计轨迹 + 验收指标(在验证集上的 base)。

所有异常个体 fitness=-inf 并被剔除，绝不中断全局。
"""
from __future__ import annotations

import logging
import random
from concurrent.futures import ProcessPoolExecutor

import numpy as np
import pandas as pd

from factor_miner.engine.crossover import subtree_crossover
from factor_miner.engine.evaluator import as_series, evaluate_tree
from factor_miner.engine.mutation import mutate
from factor_miner.engine.selection import elite, select_parents
from factor_miner.fitness.metrics import fitness_of, mean_rankic
from factor_miner.tree.generator import Generator
from factor_miner.tree.node import Node
from factor_miner.tree.serialize import canonical_key, from_prefix, to_prefix
from factor_miner.utils.checkpoint import clear_checkpoint, load_checkpoint, save_checkpoint

logger = logging.getLogger("factor_miner")

# 并行 worker 全局状态
_PANEL = None
_FWD = None
_CFG = None
_SELECTED = None


def _init_worker(panel, fwd, cfg, selected):
    global _PANEL, _FWD, _CFG, _SELECTED
    _PANEL, _FWD, _CFG, _SELECTED = panel, fwd, cfg, selected


def _eval_one(prefix: str):
    node = from_prefix(prefix)
    fit, detail = fitness_of(node, _PANEL, _FWD, _CFG, _SELECTED)
    return fit, detail


def _rolling_folds(panel: pd.DataFrame, n_folds: int = 3):
    """构造 expanding walk-forward 的训练窗口与紧随其后的验证窗口。

    返回 [(train_mask, valid_mask), ...]，供滚动时序验证使用。
    """
    dates = panel.index.get_level_values(1)
    uniq = dates.unique().sort_values()
    if len(uniq) < n_folds + 2:
        return []
    edges = np.linspace(0, len(uniq), n_folds + 2).astype(int)
    folds = []
    for i in range(n_folds):
        train_hi = edges[i + 1]
        valid_hi = edges[i + 2]
        if train_hi <= 0 or valid_hi <= train_hi:
            continue
        tr_dates = uniq[:train_hi]
        va_dates = uniq[train_hi:valid_hi]
        folds.append((dates.isin(tr_dates), dates.isin(va_dates)))
    return folds


def _evaluate_population(pop: list[Node], panel: pd.DataFrame, fwd_col: str,
                         cfg: dict, selected_arrays, rolling_folds=None):
    n_jobs = int(cfg.get("evolution", {}).get("n_jobs", 1))
    # walk-forward 需要在父进程保留完整历史再按验证掩码评分；为避免并行路径
    # 静默绕过该门禁，启用 rolling 时强制走一致的单进程评价。
    if n_jobs > 1 and rolling_folds is None:
        try:
            with ProcessPoolExecutor(
                max_workers=n_jobs, initializer=_init_worker,
                initargs=(panel, fwd_col, cfg, selected_arrays),
            ) as ex:
                results = list(ex.map(_eval_one, [to_prefix(p) for p in pop]))
            for ind, (fit, detail) in zip(pop, results):
                ind.fitness, ind.metrics = fit, detail
            return
        except Exception as exc:  # 并行失败回退单进程
            logger.warning("并行求值失败，回退单进程: %s", exc)
    rolling_valid_dates = None
    if rolling_folds is not None:
        panel_dates = panel.index.get_level_values(1)
        rolling_valid_dates = [panel_dates[va_mask].unique()
                               for _, va_mask in rolling_folds]
    for ind in pop:
        fit, detail = fitness_of(ind, panel, fwd_col, cfg, selected_arrays,
                                 rolling_valid_dates=rolling_valid_dates)
        ind.fitness, ind.metrics = fit, detail


def _build_selected(pop: list[Node], panel: pd.DataFrame, n: int):
    """取种群 Top-n 的因子值数组，作为相关性惩罚的参照池。"""
    valid = [p for p in pop if p.fitness is not None and np.isfinite(p.fitness)]
    valid.sort(key=lambda x: x.fitness, reverse=True)
    out = []
    for ind in valid[:n]:
        try:
            f = evaluate_tree(ind, panel)
            if isinstance(f, pd.Series):
                out.append(f)
        except Exception:
            continue
    return out


def _dedup(pop: list[Node], gen: Generator, max_depth: int, cap: int = 8) -> list[Node]:
    seen: dict[str, bool] = {}
    out: list[Node] = []
    for ind in pop:
        key = canonical_key(ind)
        if key in seen:
            replaced = False
            for _ in range(cap):
                cand = gen.generate()
                k2 = canonical_key(cand)
                if k2 not in seen:
                    ind, key = cand, k2
                    replaced = True
                    break
            if not replaced:
                continue
        seen[key] = True
        out.append(ind)
    return out


def evolve(cfg: dict, panels: dict, resume: bool = False, ckpt_path: str = "output/checkpoint.pkl"):
    """运行进化，返回 (best_node, trace)。

    best_node 为验证集早停判定的最优个体（含验证集指标）。
    trace 为每代统计列表（用于日志/绘图）。
    """
    ev = cfg["evolution"]
    pop_size = int(ev.get("population_size", 300))
    generations = int(ev.get("generations", 40))
    max_depth = int(ev.get("max_depth", 6))
    tournament_size = int(ev.get("tournament_size", 5))
    elite_size = max(1, int(ev.get("elite_size", 2)))
    crossover_rate = float(ev.get("crossover_rate", 0.8))
    mutation_rate = float(ev.get("mutation_rate", 0.2))
    seed = int(ev.get("seed", 0))
    early = ev.get("early_stop", {})
    patience = int(early.get("patience", 10))
    min_delta = float(early.get("min_delta", 1e-4))
    ckpt_freq = int(ev.get("checkpoint_freq", 5))

    fwd_col = f"forward_ret_{cfg['data'].get('label_window', 5)}"
    rng = random.Random(seed)
    gen = Generator(cfg, rng)

    pop: list[Node] = []
    start_gen = 0
    trace: list[dict] = []
    best_val = -np.inf
    no_improve = 0
    best_node: Node | None = None

    # 断点恢复
    if resume:
        st = load_checkpoint(ckpt_path)
        if st is not None:
            start_gen = st["generation"]
            trace = st["trace"]
            best_val = st.get("best_val", -np.inf)
            no_improve = st.get("no_improve", 0)
            best_node = from_prefix(st["best_prefix"]) if st.get("best_prefix") else None
            rng.setstate(st["rng_state"])
            pop = [from_prefix(p) for p in st["population"]]
            logger.info("已从检查点恢复：从第 %d 代继续", start_gen)

    if not pop:
        pop = [gen.generate() for _ in range(pop_size)]

    # 种子因子保护（M2）：把已知有效因子注入初始种群并保证每代保留
    seed_exprs = cfg["evolution"].get("seed_factors") or []
    seeds: list[Node] = []
    for pf in seed_exprs:
        try:
            seeds.append(from_prefix(pf))
        except Exception as exc:
            logger.warning("种子因子解析失败，跳过: %s (%s)", pf, exc)
    seed_keys = {canonical_key(s) for s in seeds}
    if seeds:
        pop = [s.clone() for s in seeds] + \
              [gen.generate() for _ in range(max(0, pop_size - len(seeds)))]
        logger.info("种子因子保护：注入 %d 个种子因子", len(seeds))

    # 方法学门禁：进化、交叉和变异的选择适应度只能读取训练集。
    # 验证集仅用于选代/早停，测试集在本函数中永不读取。
    fc = cfg.get("fitness", {})
    fit_panel = panels["train"]
    if bool(fc.get("use_combined_panel", False)):
        logger.warning("已忽略 use_combined_panel=true：选择适应度强制仅使用训练集")

    # 滚动时序验证（M2）：预计算折划分，选择适应度改用 OOS RankIC 均值
    vc = cfg.get("validation", {})
    rolling = bool(vc.get("rolling", False))
    folds = _rolling_folds(fit_panel, int(vc.get("n_folds", 3))) if rolling else None
    if rolling and folds:
        logger.info("滚动时序验证：%d 折 OOS 选择适应度启用", len(folds))

    for g in range(start_gen, generations):
        _evaluate_population(pop, fit_panel, fwd_col, cfg,
                             _build_selected(pop, fit_panel, elite_size), folds)

        valid = [p for p in pop if p.fitness is not None and np.isfinite(p.fitness)]
        valid.sort(key=lambda x: x.fitness, reverse=True)
        if not valid:
            logger.warning("第 %d 代全种群无效，重新随机初始化", g)
            pop = [gen.generate() for _ in range(pop_size)]
            no_improve += 1
            if no_improve >= patience:
                break
            continue

        best = valid[0]
        # 在完整历史上计算时间序列算子，再只截取验证索引评分，保留预热且不
        # 把预热样本纳入统计。验证集只用于选代/早停。
        try:
            full_factor = as_series(evaluate_tree(best, panels["full"]), panels["full"])
            val_factor = full_factor.reindex(panels["valid"].index)
            val_base = mean_rankic(val_factor, panels["valid"][fwd_col])
            val_fit = float(val_base) if np.isfinite(val_base) else -np.inf
            val_detail = {"base": val_fit, "validation_only": True}
        except Exception:
            val_fit, val_detail = -np.inf, {"base": -np.inf, "validation_only": True}
        if np.isfinite(val_fit) and val_fit > best_val + min_delta:
            best_val = val_fit
            no_improve = 0
            best_node = best.clone()
            best_node.metrics = val_detail
        else:
            no_improve += 1

        uniq = len({canonical_key(p) for p in valid})
        avg_complexity = float(np.mean([p.metrics["complexity"] for p in valid if p.metrics]))
        rec = {
            "generation": g,
            "best_train_fitness": float(best.fitness),
            "best_val_fitness": float(val_fit) if np.isfinite(val_fit) else None,
            "mean_train_fitness": float(np.mean([p.fitness for p in valid])),
            "diversity": uniq / max(1, len(valid)),
            "avg_complexity": avg_complexity,
            "best_prefix": to_prefix(best),
        }
        trace.append(rec)
        logger.info(
            "Gen %3d | train_fit=%.4f val_fit=%.4f | div=%.2f comp=%.1f | no_improve=%d",
            g, rec["best_train_fitness"], rec["best_val_fitness"] or float("nan"),
            rec["diversity"], avg_complexity, no_improve,
        )

        # 早停：验证集衰减（train 升 val 不升 → 过拟合信号）
        if no_improve >= patience:
            if best.fitness > best_val + min_delta:
                logger.warning("第 %d 代触发早停：验证集 %d 代无改善 (疑似过拟合)", g, patience)
            else:
                logger.warning("第 %d 代触发早停：验证集 %d 代无改善", g, patience)
            break

        # 检查点
        if g % ckpt_freq == 0 or g == generations - 1:
            save_checkpoint(ckpt_path, {
                "generation": g + 1,
                "trace": trace,
                "best_val": best_val,
                "no_improve": no_improve,
                "best_prefix": to_prefix(best_node) if best_node else to_prefix(best),
                "rng_state": rng.getstate(),
                "population": [to_prefix(p) for p in pop],
            })

        # 产生下一代
        diversity = rec["diversity"]
        new_pop = elite(pop, elite_size)
        while len(new_pop) < pop_size:
            p1, p2 = select_parents(pop, tournament_size, rng)
            if rng.random() < crossover_rate:
                c1, c2 = subtree_crossover(p1, p2, rng, max_depth)
            else:
                c1, c2 = p1.clone(), p2.clone()
            for child in (c1, c2):
                if rng.random() < mutation_rate:
                    child = mutate(child, rng, gen, max_depth,
                                   mutation_rate, diversity, no_improve, adapt=True)
                new_pop.append(child)
        new_pop = _dedup(new_pop, gen, max_depth)
        # 种子因子保护（M2）：确保种子因子在每代都被保留（不被交叉/变异淘汰）
        if seed_keys:
            cur = {canonical_key(p) for p in new_pop}
            for s in seeds:
                if canonical_key(s) not in cur:
                    new_pop.append(s.clone())
                    cur.add(canonical_key(s))
        # 维持种群规模上限（避免种子注入导致持续膨胀），但始终保留种子因子
        if len(new_pop) > pop_size:
            seed_set = [p for p in new_pop if canonical_key(p) in seed_keys]
            rest = [p for p in new_pop if canonical_key(p) not in seed_keys]
            rest.sort(key=lambda x: (x.fitness if x.fitness is not None
                                     and np.isfinite(x.fitness) else -np.inf),
                      reverse=True)
            new_pop = seed_set + rest[:max(0, pop_size - len(seed_set))]
        pop = new_pop

    if best_node is None:
        best_node = valid[0].clone() if valid else pop[0]

    # 进化结束清理检查点
    clear_checkpoint(ckpt_path)
    logger.info("进化完成：最优验证集适应度=%.4f", best_val)
    return best_node, trace
