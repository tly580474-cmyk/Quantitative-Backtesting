"""结果导出：Top 因子 CSV、验收报告 Markdown、进化轨迹 CSV。

results 中每个因子为 dict（含 'factor' Series 及其他标量指标）；
导出 CSV/MD 时自动剔除 Series，仅保留可序列化字段。
"""
from __future__ import annotations

import logging
import os

import numpy as np
import pandas as pd

from factor_miner.utils.io import ensure_dir, write_csv, write_json, write_text

logger = logging.getLogger("factor_miner")

SERIAL_FIELDS = [
    "formula", "prefix", "train_rankic", "test_rankic", "train_icir", "test_icir",
    "test_ic_t", "ls_sharpe", "mdd", "oos_decay", "mi_test", "top_mean_ret",
    "bottom_mean_ret", "corr_max", "rolling_mean", "rolling_min",
    "test_rankic_by_window", "passed",
    "ast_compatible", "ast_json", "ast_error", "evaluation_kind",
    "search_trials", "deflated_sharpe_probability",
    "seed_occurrence", "seed_count", "gross_sharpe", "stressed_cost_sharpe",
    "size_exposure", "liquidity_exposure", "industry_dispersion",
    "complexity_depth", "complexity_nodes",
]


def _flat(results: list[dict]) -> list[dict]:
    out = []
    for r in results:
        row = {k: r.get(k) for k in SERIAL_FIELDS}
        out.append(row)
    return out


def _fmt(v, fmt: str, na: str = "N/A") -> str:
    """安全格式化：None / nan / inf 统一输出 na，避免 %.3f 对 None 崩溃。"""
    try:
        if v is None:
            return na
        fv = float(v)
        if not np.isfinite(fv):
            return na
    except (TypeError, ValueError):
        return na
    return format(fv, fmt)


def export_top_factors_csv(results: list[dict], path: str) -> None:
    write_csv(path, _flat(results), fieldnames=SERIAL_FIELDS)


def export_trace_csv(trace: list[dict], path: str) -> None:
    if trace:
        write_csv(path, trace)


def export_acceptance_md(results: list[dict], cfg: dict, path: str) -> None:
    acc = cfg.get("acceptance", {})
    n_pass = sum(1 for r in results if r.get("passed"))
    lines = ["# 因子验收报告", ""]
    lines.append(f"- 候选因子数：{len(results)}，通过验收：{n_pass}")
    lines.append("")
    lines.append("## 验收阈值")
    for k, v in acc.items():
        lines.append(f"- {k}: {v}")
    lines.append("")
    lines.append("## Top 因子明细")
    for i, r in enumerate(results, 1):
        status = "✅ 通过" if r.get("passed") else "❌ 未通过"
        formula = r.get("formula") or "N/A"
        prefix = r.get("prefix") or "N/A"
        lines.append(f"### {i}. {formula}  —— {status}")
        lines.append(f"- 表达式： `{prefix}`")
        lines.append(f"- 样本外 |RankIC|: {_fmt(r.get('test_rankic'), '.4f')}  (阈值 ≥ {acc.get('oos_abs_rankic')})")
        lines.append(f"- ICIR: {_fmt(r.get('test_icir'), '.3f')}  (阈值 ≥ {acc.get('icir')})")
        lines.append(f"- IC t 值: {_fmt(r.get('test_ic_t'), '.2f')}  (阈值 ≥ {acc.get('ic_t')})")
        lines.append(f"- 多空夏普: {_fmt(r.get('ls_sharpe'), '.2f')}  (阈值 ≥ {acc.get('long_short_sharpe')})")
        lines.append(f"- Deflated Sharpe 概率: {_fmt(r.get('deflated_sharpe_probability'), '.3f')}  (阈值 ≥ {acc.get('deflated_sharpe_probability')})")
        lines.append(f"- 本次搜索试验数: {r.get('search_trials', 'N/A')}")
        lines.append(f"- 随机种子复现: {r.get('seed_occurrence', 'N/A')}/{r.get('seed_count', 'N/A')}")
        lines.append(f"- 毛收益/双倍成本夏普: {_fmt(r.get('gross_sharpe'), '.2f')} / {_fmt(r.get('stressed_cost_sharpe'), '.2f')}")
        lines.append(f"- 规模/流动性暴露: {_fmt(r.get('size_exposure'), '.3f')} / {_fmt(r.get('liquidity_exposure'), '.3f')}")
        lines.append(f"- 行业均值离散度: {_fmt(r.get('industry_dispersion'), '.3f')}")
        lines.append(f"- 最大回撤: {_fmt(r.get('mdd'), '.3f')}  (阈值 ≤ {acc.get('max_drawdown')})")
        lines.append(f"- 样本外衰减: {_fmt(r.get('oos_decay'), '.3f')}  (阈值 ≤ {acc.get('oos_ic_decay')})")
        lines.append(f"- 与库内最大相关: {_fmt(r.get('corr_max'), '.3f')}  (阈值 ≤ {acc.get('factor_corr')})")
        lines.append(f"- 滚动验证 RankIC 均值: {_fmt(r.get('rolling_mean'), '.4f')}  最小窗: {_fmt(r.get('rolling_min'), '.4f')}")
        bw = r.get("test_rankic_by_window") or {}
        if bw:
            s = ", ".join(f"w{w}={_fmt(v, '.4f')}" for w, v in sorted(bw.items()))
            lines.append(f"- 多窗口测试 RankIC: {s}")
        lines.append("")
    write_text(path, "\n".join(lines))


def export_all(results: list[dict], trace: list[dict], cfg: dict, out_dir: str) -> dict:
    ensure_dir(out_dir)
    csv_path = os.path.join(out_dir, "top_factors.csv")
    md_path = os.path.join(out_dir, "acceptance_report.md")
    trace_path = os.path.join(out_dir, "evolution_trace.csv")
    candidates_path = os.path.join(out_dir, "candidates.json")
    # 先导出不易出错的文件，最后再导出 Markdown，避免中间异常丢轨迹
    export_top_factors_csv(results, csv_path)
    export_trace_csv(trace, trace_path)
    export_acceptance_md(results, cfg, md_path)
    write_json(candidates_path, _flat(results))
    logger.info("报告已导出: %s", out_dir)
    return {"csv": csv_path, "md": md_path, "trace": trace_path,
            "candidates": candidates_path}
