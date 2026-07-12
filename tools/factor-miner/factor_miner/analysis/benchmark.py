"""M3 算力资源测算：单代评估耗时 / 峰值内存 / 并行加速比 + 参数推荐。

纯 Python GP 的瓶颈是「逐个体向量化求值」：每代要对 ``population_size`` 棵树在
整个面板上 ``evaluate_tree`` 一次。本模块提供可复现的测量与可解释的外推，
供 M3-2（Dask 分块）与运行参数决策使用。

所有测量均基于合成面板（``make_synthetic_panel``），与真实数据同形，可用于趋势判断。
"""
from __future__ import annotations

import copy
import logging
import time
from pathlib import Path

import numpy as np
import pandas as pd

from factor_miner.engine.evaluator import evaluate_tree
from factor_miner.tree.generator import Generator
from factor_miner.tree.serialize import from_prefix, to_prefix

logger = logging.getLogger("factor_miner")

try:
    import psutil
    _HAS_PSUTIL = True
except Exception:  # pragma: no cover
    _HAS_PSUTIL = False


# ----------------------------------------------------------------------------
# 测量原语
# ----------------------------------------------------------------------------
def _rss_mb() -> float:
    if not _HAS_PSUTIL:
        return float("nan")
    return psutil.Process().memory_info().rss / 1e6


def _gen_trees(cfg: dict, n: int, seed: int):
    import random
    rng = random.Random(seed)
    g = Generator(cfg, rng)
    return [g.generate() for _ in range(n)]


def benchmark_evaluate(panel: pd.DataFrame, cfg: dict,
                       n_trees: int = 200, seed: int = 0,
                       warmup: int = 10) -> dict:
    """测量在给定面板上评估 ``n_trees`` 棵随机树的耗时与峰值内存（单线程）。

    返回 dict：``per_tree_ms``、``trees_per_sec``、``peak_mem_mb``（相对增量）、
    ``abs_peak_mem_mb``、``panel_shape`` 等。
    """
    trees = _gen_trees(cfg, n_trees + warmup, seed)
    for t in trees[:warmup]:           # 预热（JIT/缓存/首次 import 副作用）
        evaluate_tree(t, panel)
    trees = trees[warmup:]

    base = _rss_mb()
    peak = base
    t0 = time.perf_counter()
    for t in trees:
        evaluate_tree(t, panel)
        if _HAS_PSUTIL:
            m = _rss_mb()
            if m > peak:
                peak = m
    dt = time.perf_counter() - t0

    per = (dt / len(trees)) * 1000.0
    return {
        "n_trees": len(trees),
        "total_s": dt,
        "per_tree_ms": per,
        "trees_per_sec": len(trees) / dt if dt > 0 else float("nan"),
        "peak_mem_mb": (peak - base) if _HAS_PSUTIL else float("nan"),
        "abs_peak_mem_mb": peak,
        "panel_shape": list(panel.shape),
    }


def benchmark_parallel_speedup(panel: pd.DataFrame, cfg: dict,
                               n_trees: int = 120, seed: int = 1,
                               n_jobs_list=(1, 2, 4)) -> dict:
    """用 multiprocessing.Pool 测量并行加速比（按 n_jobs 扫描）。

    worker 完全自包含：任务携带「可 pickle 的小规格」，子进程按规格自行重建面板
    （每 worker 缓存一次），规避 Windows spawn 下全局状态/大 DataFrame pickle 问题。
    返回 {n_jobs: speedup}。
    """
    from multiprocessing import Pool

    trees = _gen_trees(cfg, n_trees, seed)
    prefixes = [to_prefix(t) for t in trees]

    # 面板重建规格（确定性：相同 seed/规模 => 相同面板）
    spec = {
        "ns": int(panel.index.get_level_values(0).nunique()),
        "nd": int(panel.index.get_level_values(1).nunique()),
        "seed": int(cfg["evolution"]["seed"]),
        "label_window": int(cfg["data"].get("label_window", 5)),
        "label_windows": cfg["data"].get("label_windows"),
        "fwd": panel.columns[-1] if "forward_ret" in str(panel.columns[-1]) else None,
    }
    tasks = [(p, spec) for p in prefixes]

    out: dict = {}
    # 单线程基准：直接调用 worker（无 Pool）
    t0 = time.perf_counter()
    for p in prefixes:
        _bench_worker((p, spec))
    base_dt = time.perf_counter() - t0
    out[1] = 1.0

    for nj in n_jobs_list:
        if nj <= 1:
            continue
        with Pool(processes=nj) as pool:
            t0 = time.perf_counter()
            list(pool.map(_bench_worker, tasks))
            dt = time.perf_counter() - t0
        out[nj] = base_dt / dt if dt > 0 else float("nan")
    return {"n_jobs_list": list(n_jobs_list), "speedup": out, "base_dt_s": base_dt}


# 模块级面板缓存（worker 自重建，按规格缓存，兼容 Windows spawn）
_PANEL_CACHE: dict = {}


def _bench_worker(arg) -> float:
    prefix, spec = arg
    key = tuple(sorted((k, str(v)) for k, v in spec.items()))
    if key not in _PANEL_CACHE:
        from factor_miner.data.loader import make_synthetic_panel
        panel = make_synthetic_panel(
            n_symbols=spec["ns"], n_dates=spec["nd"], seed=spec["seed"],
            label_window=spec["label_window"],
            label_windows=spec["label_windows"],
        )["train"]
        _PANEL_CACHE[key] = panel
    node = from_prefix(prefix)
    s = evaluate_tree(node, _PANEL_CACHE[key])
    if s is None or (hasattr(s, "isna") and bool(s.isna().all())):
        return 0.0
    return float(np.nanmean(s.to_numpy(dtype="float64"))) if hasattr(s, "to_numpy") else 0.0


# 外推与推荐
# ----------------------------------------------------------------------------
def benchmark_evolution(panels: dict, cfg: dict, pop: int = 30, gens: int = 3) -> dict:
    """跑一轮小型真实进化，测量真实每代耗时（含适应度分析/去重/滚动验证等全链路开销）。

    用于校准参数推荐——纯树求值远快于真实每代（瓶颈在适应度分析，而非树求值）。
    """
    from factor_miner.engine.evolve import evolve

    small = copy.deepcopy(cfg)
    small["evolution"]["population_size"] = pop
    small["evolution"]["generations"] = gens
    small["evolution"]["checkpoint_freq"] = 10 ** 9  # 不写检查点拖慢
    t0 = time.perf_counter()
    _, trace = evolve(small, panels)
    dt = time.perf_counter() - t0
    per_gen = dt / max(len(trace), 1)
    return {"pop": pop, "gens": gens, "total_s": dt, "per_gen_s": per_gen,
            "n_trace": len(trace), "panel_shape": list(panels["train"].shape)}


def estimate_generation(pop: int, per_tree_ms: float,
                        speedup: float = 1.0, overhead_s: float = 0.5) -> float:
    """估算单代「仅树求值」耗时（秒）。``overhead_s`` 为选择/交叉/变异等固定开销。
    注意：真实每代还含适应度分析（rolling_cv/layer_backtest/dedup），见 benchmark_evolution。"""
    return pop * per_tree_ms / 1000.0 / max(speedup, 1e-6) + overhead_s


def recommend(cfg: dict, bench: dict, parallel: dict | None = None,
              time_budget_h: float = 2.0, per_gen_s_empirical: float | None = None) -> dict:
    """基于实测给出参数推荐（校准版）。

    ``bench`` 来自 ``benchmark_evaluate``；``parallel`` 来自 ``benchmark_parallel_speedup``；
    ``per_gen_s_empirical`` 来自 ``benchmark_evolution``（真实每代，含适应度分析）。
    若提供真实每代耗时，则以它为基准做外推（比纯树求值估计更准）。
    """
    per_tree_ms = float(bench.get("per_tree_ms") or 1.0)
    speedup = 1.0
    if parallel:
        sp = parallel.get("speedup", {})
        speedup = max(sp.get(4, sp.get(2, 1.0)), 1.0)
    n_jobs = 4 if speedup > 1.5 else (2 if speedup > 1.1 else 1)

    # 真实每代耗时（含适应度分析）；并行加速作用于整代
    if per_gen_s_empirical and per_gen_s_empirical > 0:
        gen_s_real = per_gen_s_empirical / max(speedup, 1.0)
        gen_s_primitive = estimate_generation(300, per_tree_ms, speedup)
        gen_s = gen_s_real
        est_mode = "empirical"
    else:
        gen_s = estimate_generation(300, per_tree_ms, speedup)
        gen_s_primitive = gen_s
        gen_s_real = float("nan")
        est_mode = "primitive"

    budget_s = time_budget_h * 3600.0
    max_gens = int(budget_s / gen_s) if gen_s > 0 else 0

    rec_pop = int(cfg.get("evolution", {}).get("population_size", 300))
    rec_gens = max(10, min(max_gens, int(cfg.get("evolution", {}).get("generations", 40))))
    rec_gen_s = gen_s * (rec_pop / 300.0)  # 每代随种群线性缩放（真实/原始一致）
    rec_total_s = rec_gen_s * rec_gens

    mem_mb = bench.get("abs_peak_mem_mb", float("nan"))
    return {
        "measured_per_tree_ms": per_tree_ms,
        "measured_parallel_speedup": speedup,
        "recommend_population": rec_pop,
        "recommend_generations": rec_gens,
        "recommend_n_jobs": n_jobs,
        "est_mode": est_mode,
        "est_per_gen_s_primitive": gen_s_primitive,
        "est_per_gen_s_real": gen_s_real,
        "est_per_gen_s": rec_gen_s,
        "est_total_s": rec_total_s,
        "est_total_min": rec_total_s / 60.0,
        "budget_h": time_budget_h,
        "max_gens_in_budget": max_gens,
        "peak_mem_mb": mem_mb,
        "note": (
            "纯树求值仅 ~%.1f ms/树，但真实每代含适应度分析（rolling_cv/layer_backtest/"
            "dedup/合并面板IC），耗时为树求值的数十倍——瓶颈在适应度分析而非树求值。"
            "并行在 n_jobs 上近似线性加速；面板放大时峰值内存上升，全市场（~1700万行）"
            "需 M3-2 Dask 分块避免一次性载入内存。" % per_tree_ms
        ),
    }


def summarize(panel: pd.DataFrame, cfg: dict, out_json: str | None = None,
              n_trees: int = 200, measure_parallel: bool = True,
              panels: dict | None = None, measure_real: bool = False,
              real_pop: int = 30, real_gens: int = 3) -> dict:
    """一键测算：单线程 +（可选）并行 +（可选）真实小进化校准。

    ``panels`` 为 train/valid/test 字典（benchmark_evolution 需要）；``measure_real``
    开启时跑一轮小型真实进化得到真实每代耗时，用于校准推荐。
    """
    bench = benchmark_evaluate(panel, cfg, n_trees=n_trees)
    parallel = None
    if measure_parallel:
        try:
            parallel = benchmark_parallel_speedup(panel, cfg, n_trees=120)
        except Exception as exc:  # pragma: no cover
            logger.warning("并行加速比测量失败（跳过）: %s", exc)
    real = None
    per_gen_real = None
    if measure_real and panels is not None:
        try:
            real = benchmark_evolution(panels, cfg, pop=real_pop, gens=real_gens)
            # 缩放到参考种群 300（n_jobs=1 基准），便于与原始估计对齐
            per_gen_real = real.get("per_gen_s") * (
                300.0 / max(real.get("pop", real_pop), 1))
        except Exception as exc:  # pragma: no cover
            logger.warning("真实小进化测量失败（跳过）: %s", exc)
    rec = recommend(cfg, bench, parallel, per_gen_s_empirical=per_gen_real)
    result = {"benchmark": bench, "parallel": parallel, "real_evolution": real,
              "recommend": rec}
    if out_json:
        from factor_miner.utils.io import write_json
        write_json(out_json, result)
        logger.info("算力测算已写出: %s", out_json)
    return result
