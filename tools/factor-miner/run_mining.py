"""端到端入口：配置驱动的遗传算法自动因子挖掘。

用法::

    # 真实 A 股数据（本地 MySQL，只读）
    python run_mining.py

    # 快速验证（小样本 + 少代数）
    python run_mining.py --quick

    # 无数据库冒烟测试（合成数据，CI 友好）
    python run_mining.py --synthetic

    # 断点续跑
    python run_mining.py --resume

    # 仅重生成报告：从已保存的 top_factors.csv 重新评估（不重新进化）
    python run_mining.py --report-only

    # 指定用户配置覆盖默认值
    python run_mining.py --config my_config.yaml
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import logging
import os
import platform
import re
import sys
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd
import yaml

# 允许从项目根目录直接运行
ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from factor_miner.analysis.dedup import dedup_factors   # noqa: E402
from factor_miner.analysis.ic import analyze_ic, rolling_cv  # noqa: E402
from factor_miner.analysis.layer import layer_backtest  # noqa: E402
from factor_miner.analysis.multiple_testing import deflated_sharpe_probability  # noqa: E402
from factor_miner.data.loader import build_panel, make_synthetic_panel  # noqa: E402
from factor_miner.engine.evaluator import evaluate_tree  # noqa: E402
from factor_miner.engine.evolve import evolve           # noqa: E402
from factor_miner.fitness.metrics import cross_section_rank  # noqa: E402
from factor_miner.report.exporter import export_all      # noqa: E402
from factor_miner.tree.serialize import from_prefix, to_formula  # noqa: E402
from factor_miner.tree.ast import to_ast_expression             # noqa: E402
from factor_miner.utils.logging import setup_logging    # noqa: E402
from factor_miner.utils.io import write_json            # noqa: E402

LOG = logging.getLogger("factor_miner")


def load_config(path: str | None) -> dict:
    base = ROOT / "factor_miner" / "config" / "default.yaml"
    with open(base, "r", encoding="utf-8") as f:
        cfg = yaml.safe_load(f)
    if path and Path(path).exists():
        with open(path, "r", encoding="utf-8") as f:
            user = yaml.safe_load(f) or {}
        _deep_update(cfg, user)
        LOG.info("已加载用户配置覆盖: %s", path)
    return cfg


def _deep_update(a: dict, b: dict) -> None:
    for k, v in b.items():
        if isinstance(v, dict) and isinstance(a.get(k), dict):
            _deep_update(a[k], v)
        else:
            a[k] = v


def _val(x, default):
    """返回有限数值；None/nan/inf 时用默认值（避免 `x or d` 把合法 0.0 误判）。"""
    if x is None:
        return default
    try:
        fv = float(x)
    except (TypeError, ValueError):
        return default
    return fv if np.isfinite(fv) else default


def _oos_decay(train_ric, test_ric):
    """训练→测试 IC 衰减 = 1 - |IC_test|/|IC_train|；无法计算时返回 None。"""
    tr, te = _val(train_ric, None), _val(test_ric, None)
    if tr is None or te is None:
        return None
    if np.isclose(tr, 0):
        return None
    return float(1 - abs(te) / abs(tr))


def check_acceptance(c: dict, acc: dict) -> bool:
    return bool(
        abs(_val(c.get("test_rankic"), 0)) >= acc.get("oos_abs_rankic", 0)
        and _val(c.get("test_icir"), -9) >= acc.get("icir", 0)
        and _val(c.get("test_ic_t"), -9) >= acc.get("ic_t", 0)
        and _val(c.get("ls_sharpe"), -9) >= acc.get("long_short_sharpe", 0)
        and _val(c.get("deflated_sharpe_probability"), -9) >= acc.get("deflated_sharpe_probability", 0)
        and _val(c.get("stressed_cost_sharpe"), -9) >= acc.get("stressed_cost_sharpe", 0)
        # 回撤为负：因子回撤应不劣于阈值（即 mdd >= 阈值，更接近 0）
        and _val(c.get("mdd"), 0) >= acc.get("max_drawdown", 0)
        and _val(c.get("oos_decay"), 0) <= acc.get("oos_ic_decay", 1)
        and (c.get("top_mean_ret") or 0) > (c.get("bottom_mean_ret") or 0)
    )


def _collect_candidates(prefixes: list[str], panels: dict, cfg: dict,
                        has_test: bool) -> list[dict]:
    """逐个表达式在训练/测试面板上评估，产出候选因子指标。

    关键：测试集 IC 必须用「测试面板上的因子值」对齐「测试集前向收益」，
    不能用训练面板因子（索引错位会导致 IC 全为 NaN）。
    M2：额外产出多窗口测试 IC 与滚动时序验证（逐窗 RankIC 稳定性）。
    """
    fwd = f"forward_ret_{cfg['data']['label_window']}"
    windows = cfg["data"].get("label_windows") or [cfg["data"]["label_window"]]
    n_splits = int(cfg.get("report", {}).get("rolling_splits", 5))
    # 优化：预计算各窗口标签的截面 rank（标签固定，全候选因子仅计算一次复用）
    _win_cols = [int(w) for w in windows]
    _main_w = int(cfg["data"]["label_window"])
    _lr_train = {w: cross_section_rank(panels["train"][f"forward_ret_{w}"])
                 for w in _win_cols}
    _lr_test = {w: cross_section_rank(panels["test"][f"forward_ret_{w}"])
                for w in _win_cols} if has_test else {}
    candidates: list[dict] = []
    bt = cfg.get("backtest", {})
    per_leg_cost_bps = (float(bt.get("commission_bps", 0))
                        + float(bt.get("slippage_bps", 0))
                        + float(bt.get("stamp_tax_bps", 0)) / 2.0)
    stressed_multiplier = float(cfg.get("robustness", {}).get("stressed_cost_multiplier", 2.0))
    seen: set[str] = set()
    for pf in prefixes:
        if pf in seen:
            continue
        seen.add(pf)
        try:
            node = from_prefix(pf)
        except Exception as exc:
            LOG.warning("表达式解析失败，跳过: %s (%s)", pf, exc)
            continue
        factor_full = evaluate_tree(node, panels.get("full", panels["train"]))
        if not isinstance(factor_full, pd.Series):
            factor_full = pd.Series(factor_full, index=panels.get("full", panels["train"]).index)
        factor_train = factor_full.reindex(panels["train"].index)
        if not isinstance(factor_train, pd.Series) or factor_train.isna().all():
            continue
        # 优化：每个因子仅计算一次截面 rank，供 analyze_ic / rolling_cv / _win_ic 复用
        _fr_train = cross_section_rank(factor_train)
        if has_test:
            factor_test = factor_full.reindex(panels["test"].index)
            if not isinstance(factor_test, pd.Series) or factor_test.isna().all():
                continue
            _fr_test = cross_section_rank(factor_test)
            ic_tr = analyze_ic(factor_train, panels["train"][fwd],
                               label_rank_train=_lr_train[_main_w],
                               factor_rank=_fr_train)
            ic_te = analyze_ic(factor_test, panels["test"][fwd],
                               label_rank_test=_lr_test[_main_w],
                               factor_rank=_fr_test)
            tr, te = ic_tr["train"], ic_te["train"]
            by_window = {int(w): _win_ic(factor_test, panels["test"], w,
                                         _lr_test[int(w)], _fr_test)
                         for w in windows}
            rcv = rolling_cv(factor_test, panels["test"][fwd], panels["test"],
                             n_splits, label_rank=_lr_test[_main_w],
                             factor_rank=_fr_test)
            c = {
                "factor": factor_test,
                "train_rankic": tr.get("rankic"),
                "test_rankic": te.get("rankic"),
                "train_icir": tr.get("icir"),
                "test_icir": te.get("icir"),
                "test_ic_t": te.get("ic_t"),
                "mi_test": ic_te.get("mi_train"),
                "oos_decay": _oos_decay(tr.get("rankic"), te.get("rankic")),
                "test_rankic_by_window": by_window,
                "rolling_mean": rcv.get("mean"),
                "rolling_min": rcv.get("min"),
            }
            lb = layer_backtest(factor_test, panels["test"][fwd],
                                total_cost_bps=per_leg_cost_bps)
            lb_gross = layer_backtest(factor_test, panels["test"][fwd], total_cost_bps=0)
            lb_stressed = layer_backtest(factor_test, panels["test"][fwd],
                                         total_cost_bps=per_leg_cost_bps * stressed_multiplier)
            exposure_panel = panels["test"]
        else:
            ic_tr = analyze_ic(factor_train, panels["train"][fwd],
                               label_rank_train=_lr_train[_main_w],
                               factor_rank=_fr_train)
            tr = ic_tr["train"]
            by_window = {int(w): _win_ic(factor_train, panels["train"], w,
                                         _lr_train[int(w)], _fr_train)
                         for w in windows}
            rcv = rolling_cv(factor_train, panels["train"][fwd], panels["train"],
                             n_splits, label_rank=_lr_train[_main_w],
                             factor_rank=_fr_train)
            c = {
                "factor": factor_train,
                "train_rankic": tr.get("rankic"),
                "test_rankic": tr.get("rankic"),
                "train_icir": tr.get("icir"),
                "test_icir": tr.get("icir"),
                "test_ic_t": tr.get("ic_t"),
                "mi_test": ic_tr.get("mi_train"),
                "oos_decay": 0.0,
                "test_rankic_by_window": by_window,
                "rolling_mean": rcv.get("mean"),
                "rolling_min": rcv.get("min"),
            }
            lb = layer_backtest(factor_train, panels["train"][fwd],
                                total_cost_bps=per_leg_cost_bps)
            lb_gross = layer_backtest(factor_train, panels["train"][fwd], total_cost_bps=0)
            lb_stressed = layer_backtest(factor_train, panels["train"][fwd],
                                         total_cost_bps=per_leg_cost_bps * stressed_multiplier)
            exposure_panel = panels["train"]
        c.update({
            "formula": to_formula(node),
            "prefix": pf,
            "ls_sharpe": lb.get("long_short_sharpe"),
            "mdd": lb.get("max_drawdown"),
            "top_mean_ret": lb.get("top_mean_ret"),
            "bottom_mean_ret": lb.get("bottom_mean_ret"),
            "long_short_series": lb.get("long_short_series"),
            "periods_per_year": lb.get("periods_per_year"),
            "complexity_depth": node.depth(),
            "complexity_nodes": node.size(),
            "gross_sharpe": lb_gross.get("long_short_sharpe"),
            "stressed_cost_sharpe": lb_stressed.get("long_short_sharpe"),
        })
        c.update(_factor_exposures(c["factor"], exposure_panel))
        try:
            c["ast"] = to_ast_expression(node)
            c["ast_compatible"] = True
            c["ast_json"] = json.dumps(c["ast"], ensure_ascii=False,
                                       sort_keys=True, separators=(",", ":"))
        except ValueError as exc:
            c["ast"] = None
            c["ast_compatible"] = False
            c["ast_json"] = None
            c["ast_error"] = str(exc)
        candidates.append(c)
    return candidates


def _win_ic(factor: "pd.Series", panel, w, label_rank: "pd.Series | None" = None,
            factor_rank: "pd.Series | None" = None) -> float | None:
    """计算某窗口 w 下的测试 RankIC（用于多窗口标签报告）。"""
    col = f"forward_ret_{int(w)}"
    if col not in panel.columns:
        return None
    try:
        m = analyze_ic(factor, panel[col], label_rank_train=label_rank,
                       factor_rank=factor_rank)
        return m["train"].get("rankic")
    except Exception:
        return None


def _parse_trace_from_log(log_path: str) -> list[dict]:
    """从运行日志重建进化轨迹（checkpoint 已清理时的兜底）。"""
    recs: list[dict] = []
    if not os.path.exists(log_path):
        return recs
    pat = re.compile(
        r"Gen\s+(\d+)\s+\|\s+train_fit=([\d.eE+nan-]+)\s+val_fit=([\d.eE+nan-]+)"
        r"\s+\|\s+div=([\d.]+)\s+comp=([\d.]+)\s+\|\s+no_improve=(\d+)"
    )
    with open(log_path, "r", encoding="utf-8", errors="ignore") as f:
        for line in f:
            m = pat.search(line)
            if m:
                def _num(s):
                    return None if s.lower() == "nan" else float(s)
                recs.append({
                    "generation": int(m.group(1)),
                    "best_train_fitness": _num(m.group(2)),
                    "best_val_fitness": _num(m.group(3)),
                    "diversity": float(m.group(4)),
                    "avg_complexity": float(m.group(5)),
                    "best_prefix": "",
                })
    return recs


def _seed_trace_path(out_dir: str, seed: int) -> str:
    return os.path.join(out_dir, f"completed_seed_{seed}.json")


def _save_completed_seed(out_dir: str, seed: int, trace: list[dict]) -> None:
    """原子保存已完成种子的轨迹，供跨进程/超时恢复直接复用。"""
    path = _seed_trace_path(out_dir, seed)
    os.makedirs(out_dir, exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(trace, f, ensure_ascii=False, allow_nan=False)
    os.replace(tmp, path)


def _load_completed_seed(out_dir: str, seed: int) -> list[dict] | None:
    path = _seed_trace_path(out_dir, seed)
    if not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            value = json.load(f)
        return value if isinstance(value, list) else None
    except (OSError, ValueError):
        return None


def _analyze_and_export(panels: dict, trace: list[dict], cfg: dict,
                        has_test: bool) -> dict:
    """验证集筛选并冻结候选，再对冻结候选执行一次锁定测试。"""
    acc = cfg["acceptance"]
    top_k = int(cfg["report"]["top_k"])
    prefixes = [rec["best_prefix"] for rec in trace if rec.get("best_prefix")]
    # 选择阶段只允许读取 train + valid。_collect_candidates 的 test 字段在此
    # 表示 validation 指标；锁定 test 尚未进入候选排序或相关性去重。
    selection_panels = {
        "train": panels["train"],
        "test": panels["valid"],
        # 指标仍只在 train/valid 日期上计算；full 仅提供滚动算子的历史预热。
        "full": panels["full"],
    }
    selection_candidates = _collect_candidates(prefixes, selection_panels, cfg, True)
    frozen = dedup_factors(selection_candidates,
                           threshold=acc.get("factor_corr", 0.7),
                           key="test_rankic", top_k=top_k)
    frozen.sort(key=lambda x: abs(x.get("test_rankic") or 0), reverse=True)
    frozen = frozen[:top_k]

    if has_test and frozen:
        # 只有冻结后的候选能够读取锁定测试集；测试结果不再改变候选集合或顺序。
        frozen_prefixes = [c["prefix"] for c in frozen]
        tested = _collect_candidates(frozen_prefixes, panels, cfg, True)
        tested_by_prefix = {c["prefix"]: c for c in tested}
        results = [tested_by_prefix[p] for p in frozen_prefixes if p in tested_by_prefix]
    else:
        results = frozen

    is_synthetic = panels.get("data_kind") == "synthetic"
    search_trials = max(1, int(cfg.get("evolution", {}).get("population_size", 1)) * len(trace))
    seeds = sorted({rec.get("seed") for rec in trace if rec.get("seed") is not None})
    prefix_seeds = {}
    for rec in trace:
        if rec.get("best_prefix") and rec.get("seed") is not None:
            prefix_seeds.setdefault(rec["best_prefix"], set()).add(rec["seed"])
    for i, c in enumerate(results):
        mx = 0.0
        for j, o in enumerate(results):
            if i == j:
                continue
            pair = pd.concat([c["factor"], o["factor"]], axis=1).dropna()
            if len(pair) > 10:
                cc = abs(pair.iloc[:, 0].corr(pair.iloc[:, 1]))
                if np.isfinite(cc):
                    mx = max(mx, cc)
        c["corr_max"] = float(mx)
        c["search_trials"] = search_trials
        c["seed_count"] = len(seeds) or 1
        c["seed_occurrence"] = len(prefix_seeds.get(c.get("prefix"), set())) or 1
        c["deflated_sharpe_probability"] = deflated_sharpe_probability(
            c.get("long_short_series", pd.Series(dtype="float64")),
            _val(c.get("ls_sharpe"), float("nan")),
            _val(c.get("periods_per_year"), 252.0), search_trials)
        c["passed"] = bool(has_test and not is_synthetic and check_acceptance(c, acc))
        c["evaluation_kind"] = "synthetic" if is_synthetic else (
            "locked_test" if has_test else "validation_only")

    out = export_all(results, trace, cfg, cfg["report"]["out_dir"])
    manifest_path = os.path.join(cfg["report"]["out_dir"], "run_manifest.json")
    write_json(manifest_path, _build_run_manifest(panels, cfg, prefixes, results))
    out["manifest"] = manifest_path

    # M3：本地因子库持久化（SQLite + Parquet + JSON 轨迹）
    pcfg = cfg.get("persistence", {})
    if pcfg.get("enabled", False):
        try:
            from factor_miner.persistence import FactorLibrary
            run_id = "run_" + datetime.now().strftime("%Y%m%d_%H%M%S")
            lib = FactorLibrary(pcfg.get("root", "output/factor_library"),
                                version=pcfg.get("version", "v1"))
            added = 0
            for r in results:
                fid = lib.add_factor(r, run_id,
                                     store_values=pcfg.get("store_values", True))
                if fid is not None:
                    added += 1
            lib.add_trace(trace, run_id)
            sm = lib.summary()
            LOG.info("因子库持久化：本次新增 %d，库内共 %d（通过 %d）→ %s",
                     added, sm["total"], sm["passed"], lib.root)
        except Exception as exc:  # 持久化失败不应中断主流程
            LOG.warning("因子库持久化失败（跳过）：%s", exc)
    n_pass = sum(1 for r in results if r.get("passed"))
    LOG.info("=== 完成：候选 %d，去重后 %d，Top-%d 中通过验收 %d ===",
             len(selection_candidates), len(frozen), top_k, n_pass)
    for r in results[:5]:
        LOG.info("  %s | IC=%.4f | sharpe=%.2f | %s",
                 r["formula"], _val(r.get("test_rankic"), 0),
                 _val(r.get("ls_sharpe"), 0), "通过" if r.get("passed") else "未通过")

    print(f"\n报告目录: {out['md']}")
    print(f"候选因子 {len(selection_candidates)} 个，冻结后 {len(frozen)} 个，"
          f"Top-{top_k} 通过验收 {n_pass} 个")
    return out


def _build_run_manifest(panels: dict, cfg: dict, searched_prefixes: list[str],
                        results: list[dict]) -> dict:
    """生成可复现实验血缘；凭据不会写入产物。"""
    safe_cfg = json.loads(json.dumps(cfg, default=str))
    if isinstance(safe_cfg.get("data"), dict):
        safe_cfg["data"].pop("password", None)
    canonical_cfg = json.dumps(safe_cfg, ensure_ascii=False, sort_keys=True,
                               separators=(",", ":"))
    split = {}
    for name in ("train", "valid", "test"):
        panel = panels.get(name, pd.DataFrame())
        if len(panel):
            dates = panel.index.get_level_values(1)
            split[name] = {"start": str(dates.min().date()), "end": str(dates.max().date()),
                           "rows": len(panel), "symbols": int(panel.index.get_level_values(0).nunique())}
    return {
        "schema_version": 1,
        "created_at": datetime.now().astimezone().isoformat(),
        "data_kind": panels.get("data_kind", "legacy_mysql"),
        "data_lineage": panels.get("lineage", {}),
        "splits": split,
        "label": {"price": safe_cfg["data"].get("label_price"),
                  "windows": safe_cfg["data"].get("label_windows"),
                  "primary_window": safe_cfg["data"].get("label_window")},
        "random_seed": safe_cfg["evolution"].get("seed"),
        "search_seeds": safe_cfg.get("robustness", {}).get("search_seeds"),
        "config_sha256": hashlib.sha256(canonical_cfg.encode("utf-8")).hexdigest(),
        "code_sha256": _code_checksum(),
        "runtime": _runtime_versions(),
        "config": safe_cfg,
        "searched_formula_count": len(set(searched_prefixes)),
        "search_trial_count": int(results[0].get("search_trials", 0)) if results else 0,
        "frozen_candidate_count": len(results),
        "frozen_prefixes": [item.get("prefix") for item in results],
        "synthetic_oos_eligible": False if panels.get("data_kind") == "synthetic" else None,
    }


def _code_checksum() -> str:
    digest = hashlib.sha256()
    paths = [ROOT / "run_mining.py", *sorted((ROOT / "factor_miner").rglob("*.py"))]
    for path in paths:
        digest.update(path.relative_to(ROOT).as_posix().encode("utf-8"))
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def _runtime_versions() -> dict:
    packages = ["numpy", "pandas", "PyYAML", "SQLAlchemy", "PyMySQL",
                "scikit-learn", "pyarrow", "dask", "psutil"]
    versions = {}
    for package in packages:
        try:
            versions[package] = importlib.metadata.version(package)
        except importlib.metadata.PackageNotFoundError:
            versions[package] = None
    return {"python": platform.python_version(), "platform": platform.platform(),
            "packages": versions}


def _factor_exposures(factor: pd.Series, panel: pd.DataFrame) -> dict:
    aligned = pd.DataFrame({"factor": factor})
    for name, column in (("size", "log_mktcap"), ("liquidity", "amount")):
        if column in panel.columns:
            aligned[name] = panel[column]
    ranked = aligned.groupby(level=1).rank(pct=True)
    out = {
        "size_exposure": float(ranked["factor"].corr(ranked["size"])) if "size" in ranked else np.nan,
        "liquidity_exposure": float(ranked["factor"].corr(ranked["liquidity"])) if "liquidity" in ranked else np.nan,
        "industry_dispersion": np.nan,
    }
    if "industry" in panel.columns:
        sample = pd.DataFrame({"factor": ranked["factor"], "industry": panel["industry"]}).dropna()
        if len(sample):
            daily_industry = sample.groupby([sample.index.get_level_values(1), "industry"])["factor"].mean()
            out["industry_dispersion"] = float(daily_industry.groupby(level=0).std().mean())
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description="遗传算法自动因子挖掘")
    ap.add_argument("--config", default=None)
    ap.add_argument("--resume", action="store_true", help="从检查点断点续跑")
    ap.add_argument("--quick", action="store_true", help="小样本 + 少代数快速验证")
    ap.add_argument("--synthetic", action="store_true", help="使用合成数据（无需数据库）")
    ap.add_argument("--report-only", action="store_true",
                    help="从已保存的 top_factors.csv 重新评估并生成报告（不重新进化）")
    ap.add_argument("--candidate-only", action="store_true",
                    help="只在训练/验证集生成候选；禁止读取锁定测试集")
    args = ap.parse_args()

    cfg = load_config(args.config)
    if args.quick:
        cfg["data"]["sample_symbols"] = 200
        cfg["data"]["start_date"] = "2014-01-01"
        cfg["evolution"]["generations"] = 15
        cfg["evolution"]["population_size"] = 120

    setup_logging()
    LOG.info("=== 遗传算法自动因子挖掘 启动 ===")

    if args.report_only:
        LOG.info("仅重生成报告：读取已保存候选表达式重新评估（不重新进化）")
        csv_path = os.path.join(cfg["report"]["out_dir"], "top_factors.csv")
        if not os.path.exists(csv_path):
            LOG.error("未找到 %s，无法 --report-only；请先正常跑一次", csv_path)
            return
        df = pd.read_csv(csv_path)
        prefixes: list[str] = []
        for p in df["prefix"].dropna().tolist():
            if p not in prefixes:
                prefixes.append(p)
        if not prefixes:
            LOG.error("top_factors.csv 中没有可评估的表达式，无法 --report-only")
            return
        if args.synthetic:
            panels = make_synthetic_panel(
                n_symbols=60, n_dates=400, seed=cfg["evolution"]["seed"],
                label_window=cfg["data"]["label_window"],
                label_windows=cfg["data"].get("label_windows"))
        else:
            # 避免加载全市场：沿用 --quick 的抽样规模做快速重评估
            if not args.quick:
                cfg["data"]["sample_symbols"] = 200
            panels = build_panel(cfg)
        has_test = len(panels.get("test", pd.DataFrame())) > 0 and not args.candidate_only
        # 直接用 CSV 中的表达式构建轨迹，避免从日志解析时 best_prefix 为空
        trace = [{"best_prefix": p} for p in prefixes]
        _analyze_and_export(panels, trace, cfg, has_test)
        return

    if args.synthetic:
        LOG.info("使用合成数据（无数据库）")
        panels = make_synthetic_panel(
            n_symbols=60, n_dates=400, seed=cfg["evolution"]["seed"],
            label_window=cfg["data"]["label_window"],
            label_windows=cfg["data"].get("label_windows"))
    else:
        LOG.info("从本地 MySQL 读取真实 A 股数据")
        panels = build_panel(cfg)

    has_test = len(panels.get("test", pd.DataFrame())) > 0 and not args.candidate_only
    configured_seeds = cfg.get("robustness", {}).get("search_seeds") or [cfg["evolution"]["seed"]]
    seeds = list(dict.fromkeys(int(seed) for seed in configured_seeds))
    original_seed = cfg["evolution"]["seed"]
    trace = []
    out_dir = cfg["report"]["out_dir"]
    if not args.resume:
        # 显式“重新开始”不能误用同目录里旧运行的完成标记。
        for seed in seeds:
            for suffix in ("", ".tmp"):
                path = _seed_trace_path(out_dir, seed) + suffix
                if os.path.exists(path):
                    os.remove(path)
    for seed_index, seed in enumerate(seeds, start=1):
        cfg["evolution"]["seed"] = seed
        LOG.info("=== 随机种子 %d（%d/%d）===", seed, seed_index, len(seeds))
        completed = _load_completed_seed(out_dir, seed) if args.resume else None
        if completed is not None:
            LOG.info("随机种子 %d 已完成，恢复时直接复用 %d 代轨迹", seed, len(completed))
            trace.extend(completed)
            continue
        checkpoint = os.path.join(out_dir, f"checkpoint_seed_{seed}.pkl")
        _, seed_trace = evolve(cfg, panels, resume=args.resume, ckpt_path=checkpoint)
        for record in seed_trace:
            record["seed"] = seed
        _save_completed_seed(out_dir, seed, seed_trace)
        trace.extend(seed_trace)
    cfg["evolution"]["seed"] = original_seed
    _analyze_and_export(panels, trace, cfg, has_test)


if __name__ == "__main__":
    main()
