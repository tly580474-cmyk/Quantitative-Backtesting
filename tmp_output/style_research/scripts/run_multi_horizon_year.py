"""P1 多周期 + 分年度 + 因子相关性分析。

输出:
- STYLE_COMPARISON_REPORT_V3.md: 多周期评估表 + 分年度评估表 + 因子相关性表
- STYLE_COMPARISON_REPORT_V3_data.json: 详细数据

用法:
    python scripts/run_multi_horizon_year.py
    python scripts/run_multi_horizon_year.py --min-icir 2.0
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import sys
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
import yaml
from dotenv import load_dotenv

# ========== Step 1: 引导导入 ==========

STYLE_RESEARCH_ROOT = Path(__file__).resolve().parent.parent
EXPLORATION_ROOT = Path("d:/github_public_repo/评分规则探索")

if str(EXPLORATION_ROOT) not in sys.path:
    sys.path.insert(0, str(EXPLORATION_ROOT))

import src  # noqa: E402
import src.factors  # noqa: E402
import src.panel  # noqa: E402


def _load_package(file_path: Path, module_name: str) -> None:
    spec = importlib.util.spec_from_file_location(
        module_name, file_path,
        submodule_search_locations=[str(file_path.parent)],
    )
    if spec is None or spec.loader is None:
        raise RuntimeError(f"无法加载 {module_name} 从 {file_path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)


def _load_module(file_path: Path, module_name: str) -> None:
    spec = importlib.util.spec_from_file_location(module_name, file_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"无法加载 {module_name} 从 {file_path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)


_style_src = STYLE_RESEARCH_ROOT / "src"
_load_package(_style_src / "factors" / "style_specific" / "__init__.py",
              "src.factors.style_specific")
_load_module(_style_src / "panel" / "vectorized_styles.py",
            "src.panel.vectorized_styles")
_load_package(_style_src / "styles" / "__init__.py", "src.styles")

# ========== Step 2: 导入业务模块 ==========

from src.data import load_candles, open_duckdb_session  # noqa: E402
from src.factors.registry import list_all_factor_ids  # noqa: E402
from src.factors.style_specific import list_style_factor_ids  # noqa: E402
from src.panel.returns import build_return_panel  # noqa: E402
from src.panel.vectorized import (  # noqa: E402
    build_all_factor_panels_vectorized as build_existing_factor_panels,
)
from src.panel.vectorized_styles import (  # noqa: E402
    build_all_style_factor_panels_vectorized as build_style_factor_panels,
)
from src.styles import STYLE_DEFINITIONS, StyleScorer, list_style_ids  # noqa: E402


# ========== Step 3: 配置与辅助 ==========


def load_config() -> dict:
    load_dotenv(EXPLORATION_ROOT / ".env")
    config_path = EXPLORATION_ROOT / "config.yaml"
    if not config_path.exists():
        return {}
    with open(config_path, "r", encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def _fmt_pct(v):
    if v is None or (isinstance(v, float) and (np.isnan(v) or pd.isna(v))):
        return "N/A"
    return f"{v * 100:.4f}%"


def _fmt_float(v, digits: int = 4):
    if v is None or (isinstance(v, float) and (np.isnan(v) or pd.isna(v))):
        return "N/A"
    return f"{v:.{digits}f}"


# 风格专属的多周期测试范围
STYLE_HORIZONS: dict[str, list[int]] = {
    "contrarian": [3, 5, 10, 20],          # 基线对比
    "value": [5, 10, 20, 40, 60],           # 长期持有
    "growth": [5, 10, 20, 40, 60],
    "trend": [5, 10, 20, 40, 60],
    "short_term": [1, 3, 5, 10],            # 短线 1d 失效则退化
}


# ========== Step 4: 多周期评估 ==========


def run_multi_horizon_eval(
    style_results_baseline: dict,
    all_panels: dict[str, pd.DataFrame],
    candles_long: pd.DataFrame,
    layers: int,
    min_samples: int,
    min_icir: float,
) -> dict[str, dict[int, dict]]:
    """对每个风格在多个 horizon 下评估。"""
    print("\n=== 多周期评估 ===")
    multi_horizon_results: dict[str, dict[int, dict]] = {}

    for style_id in list_style_ids():
        spec = STYLE_DEFINITIONS[style_id]
        horizons = STYLE_HORIZONS[style_id]
        print(f"\n风格: {spec.style_name} ({style_id})")
        print(f"  测试 horizon: {horizons}")

        results: dict[int, dict] = {}
        for h in horizons:
            # 用 dataclasses.replace 创建临时 spec, 覆盖 target_horizon 与 weight_horizon
            temp_spec = replace(spec, target_horizon=h, weight_horizon=h)
            scorer = StyleScorer(temp_spec)
            result = scorer.evaluate(
                all_factor_panels=all_panels,
                candles_long=candles_long,
                layers=layers,
                min_samples=min_samples,
                min_icir=min_icir,
            )
            cr = result.composite_report
            results[h] = {
                "spread": cr.long_short_spread,
                "monotonicity": cr.monotonicity,
                "l1": cr.layers[0].average_return if cr.layers else None,
                "l5": cr.layers[-1].average_return if cr.layers else None,
                "n_selected": len(result.selected_factor_ids),
                "n_dropped": len(result.dropped_factors),
            }
            print(f"  h={h}d: spread={_fmt_pct(cr.long_short_spread)}, "
                  f"mono={_fmt_float(cr.monotonicity)}, "
                  f"保留={len(result.selected_factor_ids)}")

        multi_horizon_results[style_id] = results

    return multi_horizon_results


# ========== Step 5: 分年度评估 ==========


def run_by_year_eval(
    all_panels: dict[str, pd.DataFrame],
    candles_long: pd.DataFrame,
    layers: int,
    min_samples: int,
    min_icir: float,
) -> dict[str, dict[int, dict]]:
    """对每个风格分年度评估。

    关键修复: 因子面板和收益面板必须 (index, columns) 严格一致。
    做法: 对每个 (year, style), 预先用 style.target_horizon 构造收益面板,
    然后将该年份的因子面板的 (index, columns) 对齐到收益面板。
    """
    print("\n=== 分年度评估 ===")

    # 按年切片 candles_long
    candles_long = candles_long.copy()
    candles_long["tradeDate"] = candles_long["tradeDate"].astype(str)
    candles_long["year"] = candles_long["tradeDate"].str[:4].astype(int)
    years = sorted(candles_long["year"].unique().tolist())
    print(f"数据覆盖年份: {years}")

    # 预切片: 按年切 candles 与 factor 面板(仅按 tradeDate 行过滤)
    year_to_candles: dict[int, pd.DataFrame] = {}
    year_to_panels_row_only: dict[int, dict[str, pd.DataFrame]] = {}

    for year in years:
        candles_year = candles_long[candles_long["year"] == year].drop(columns=["year"])
        if len(candles_year) < 10000:
            print(f"  {year}: 数据太少 ({len(candles_year)}), 跳过分年度")
            continue
        year_to_candles[year] = candles_year

        year_dates = candles_year["tradeDate"].unique()
        year_panels: dict[str, pd.DataFrame] = {}
        for fid, panel in all_panels.items():
            if panel.empty:
                year_panels[fid] = panel
                continue
            mask = panel.index.astype(str).isin(year_dates)
            year_panels[fid] = panel.loc[mask]
        year_to_panels_row_only[year] = year_panels

    # 对每个风格 × 每个年度运行评估
    by_year_results: dict[str, dict[int, dict]] = {}
    for style_id in list_style_ids():
        spec = STYLE_DEFINITIONS[style_id]
        h = spec.target_horizon
        print(f"\n风格: {spec.style_name} ({style_id}), horizon={h}d")

        results: dict[int, dict] = {}
        for year, candles_year in year_to_candles.items():
            # 关键: 预构造该 (year, horizon) 的收益面板
            return_panel = build_return_panel(candles_year, horizon=h)
            if return_panel.empty:
                print(f"  {year}: 收益面板为空, 跳过")
                continue
            valid_dates = return_panel.index
            valid_cols = set(return_panel.columns)

            # 对齐该年份的因子面板: 行=return_panel.index, 列=return_panel.columns(顺序一致)
            return_cols = list(return_panel.columns)
            year_panels_aligned: dict[str, pd.DataFrame] = {}
            raw_year_panels = year_to_panels_row_only[year]
            for fid, panel in raw_year_panels.items():
                if panel.empty:
                    year_panels_aligned[fid] = panel
                    continue
                # 行过滤: 只保留 return_panel.index 中存在的日期, 顺序按 return_panel.index
                common_dates = [d for d in return_panel.index if d in panel.index]
                sliced = panel.loc[common_dates]
                # 列过滤: 只保留 return_panel.columns 中存在的列, 顺序按 return_panel.columns
                common_cols = [c for c in return_cols if c in sliced.columns]
                year_panels_aligned[fid] = sliced[common_cols]

            scorer = StyleScorer(spec)
            result = scorer.evaluate(
                all_factor_panels=year_panels_aligned,
                candles_long=candles_year,
                layers=layers,
                min_samples=min_samples,
                min_icir=min_icir,
            )
            cr = result.composite_report
            results[year] = {
                "spread": cr.long_short_spread,
                "monotonicity": cr.monotonicity,
                "l1": cr.layers[0].average_return if cr.layers else None,
                "l5": cr.layers[-1].average_return if cr.layers else None,
                "n_selected": len(result.selected_factor_ids),
                "n_dropped": len(result.dropped_factors),
                "candles_count": len(candles_year),
            }
            print(f"  {year}: spread={_fmt_pct(cr.long_short_spread)}, "
                  f"mono={_fmt_float(cr.monotonicity)}, "
                  f"K线={len(candles_year):,}")

        by_year_results[style_id] = results

    return by_year_results


# ========== Step 6: 因子相关性分析 ==========


def run_factor_correlation_analysis(
    all_panels: dict[str, pd.DataFrame],
    threshold: float = 0.7,
) -> dict:
    """计算因子两两相关矩阵,识别高相关因子对。"""
    print("\n=== 因子相关性分析 ===")
    print(f"高相关阈值: |corr| >= {threshold}")

    # 将每个因子面板展平为一维 Series(对齐 index 与 columns)
    factor_ids = list(all_panels.keys())
    print(f"参与因子数: {len(factor_ids)}")

    # 找到所有面板的公共 index 和 columns
    common_index = None
    common_columns = None
    for fid in factor_ids:
        p = all_panels[fid]
        if p.empty:
            continue
        if common_index is None:
            common_index = p.index
            common_columns = p.columns
        else:
            common_index = common_index.intersection(p.index)
            common_columns = common_columns.intersection(p.columns)

    if common_index is None or len(common_index) == 0:
        print("错误: 无公共日期")
        return {"matrix": {}, "high_corr_pairs": []}

    print(f"公共日期数: {len(common_index)}, 公共股票数: {len(common_columns)}")

    # 构造因子值矩阵 (date×stock 行, 因子列)
    factor_values: dict[str, np.ndarray] = {}
    for fid in factor_ids:
        p = all_panels[fid]
        if p.empty:
            continue
        aligned = p.loc[common_index, common_columns]
        factor_values[fid] = aligned.values.flatten()

    # 计算两两 Pearson 相关
    fids = list(factor_values.keys())
    n = len(fids)
    corr_matrix = np.zeros((n, n))
    for i in range(n):
        for j in range(n):
            if i == j:
                corr_matrix[i, j] = 1.0
            elif i < j:
                a = factor_values[fids[i]]
                b = factor_values[fids[j]]
                mask = np.isfinite(a) & np.isfinite(b)
                if mask.sum() < 100:
                    corr_matrix[i, j] = np.nan
                    corr_matrix[j, i] = np.nan
                else:
                    c = float(np.corrcoef(a[mask], b[mask])[0, 1])
                    corr_matrix[i, j] = c
                    corr_matrix[j, i] = c

    # 找高相关对
    high_corr_pairs = []
    for i in range(n):
        for j in range(i + 1, n):
            c = corr_matrix[i, j]
            if np.isnan(c):
                continue
            if abs(c) >= threshold:
                high_corr_pairs.append({
                    "f1": fids[i],
                    "f2": fids[j],
                    "corr": float(c),
                })
    high_corr_pairs.sort(key=lambda x: abs(x["corr"]), reverse=True)

    print(f"高相关因子对 (|corr| >= {threshold}): {len(high_corr_pairs)} 对")
    for pair in high_corr_pairs[:10]:
        print(f"  {pair['f1']} ↔ {pair['f2']}: {pair['corr']:.4f}")

    return {
        "matrix": {fids[i]: {fids[j]: float(corr_matrix[i, j])
                              for j in range(n) if not np.isnan(corr_matrix[i, j])}
                    for i in range(n)},
        "high_corr_pairs": high_corr_pairs,
        "threshold": threshold,
    }


# ========== Step 7: 报告生成 ==========


def build_v3_report(
    multi_horizon_results: dict[str, dict[int, dict]],
    by_year_results: dict[str, dict[int, dict]],
    correlation_result: dict,
    candles_count: int,
    stock_count: int,
    date_range: tuple[str, str],
    snapshot_id: str,
    min_icir: float,
    output_path: Path,
) -> None:
    """生成 V3 综合报告。"""
    lines: list[str] = []
    lines.append("# 多风格选股评分对比研究报告 (V3 - 多周期 + 分年度 + 相关性)")
    lines.append("")
    lines.append(f"**生成时间**: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    lines.append(f"**评估范围**: {date_range[0]} ~ {date_range[1]}")
    lines.append(f"**数据源**: DuckDB 研究快照 `{snapshot_id}`")
    lines.append(f"**样本规模**: {stock_count:,} 只 A 股主板股票 × "
                 f"~{candles_count // max(stock_count, 1):,} 个交易日 ≈ {candles_count:,} 条 K 线")
    lines.append(f"**min_icir**: {min_icir} (剔除 |rank_ic_ir| < {min_icir} 的弱因子)")
    lines.append("")

    # 一、多周期评估
    lines.append("## 一、多周期评估")
    lines.append("")
    lines.append("对每个风格在不同 horizon 下评估,寻找最佳持有期。")
    lines.append("")

    for style_id in list_style_ids():
        spec = STYLE_DEFINITIONS[style_id]
        results = multi_horizon_results[style_id]
        lines.append(f"### {spec.style_name} ({style_id})")
        lines.append("")
        lines.append("| horizon | 层1收益 | 层5收益 | 多空价差 | 单调性 | 保留因子 |")
        lines.append("|---------|---------|---------|----------|--------|----------|")
        for h in sorted(results.keys()):
            r = results[h]
            lines.append(
                f"| {h}d | {_fmt_pct(r['l1'])} | {_fmt_pct(r['l5'])} | "
                f"{_fmt_pct(r['spread'])} | {_fmt_float(r['monotonicity'])} | "
                f"{r['n_selected']} |"
            )
        lines.append("")

        # 找出最佳 horizon
        valid = [(h, r) for h, r in results.items() if r["spread"] is not None]
        if valid:
            best_h, best_r = max(valid, key=lambda kv: kv[1]["spread"] or -1e9)
            lines.append(f"- **最佳 horizon**: {best_h}d "
                         f"(spread={_fmt_pct(best_r['spread'])}, "
                         f"mono={_fmt_float(best_r['monotonicity'])})")
            lines.append("")

    # 二、分年度评估
    lines.append("## 二、分年度评估")
    lines.append("")
    lines.append("对每个风格按年切片,评估风格在不同市场环境下的稳定性。")
    lines.append("")

    # 表头: 风格 × 年度 spread
    all_years = sorted({y for r in by_year_results.values() for y in r.keys()})
    if all_years:
        header = "| 风格 | " + " | ".join(str(y) for y in all_years) + " | 年度胜率 |"
        sep = "|------|" + "|".join(["------"] * len(all_years)) + "|------|"
        lines.append(header)
        lines.append(sep)
        for style_id in list_style_ids():
            spec = STYLE_DEFINITIONS[style_id]
            results = by_year_results[style_id]
            row = f"| {spec.style_name} "
            n_win = 0
            n_total = 0
            for y in all_years:
                r = results.get(y)
                if r is None or r["spread"] is None:
                    row += "| N/A "
                else:
                    row += f"| {_fmt_pct(r['spread'])} "
                    n_total += 1
                    if r["spread"] > 0:
                        n_win += 1
            win_rate = n_win / n_total if n_total > 0 else 0
            row += f"| {n_win}/{n_total} ({_fmt_pct(win_rate)}) |"
            lines.append(row)
        lines.append("")

        # 分年度单调性
        lines.append("### 分年度单调性")
        lines.append("")
        header = "| 风格 | " + " | ".join(str(y) for y in all_years) + " |"
        sep = "|------|" + "|".join(["------"] * len(all_years)) + "|"
        lines.append(header)
        lines.append(sep)
        for style_id in list_style_ids():
            spec = STYLE_DEFINITIONS[style_id]
            results = by_year_results[style_id]
            row = f"| {spec.style_name} "
            for y in all_years:
                r = results.get(y)
                if r is None or r["monotonicity"] is None:
                    row += "| N/A "
                else:
                    row += f"| {_fmt_float(r['monotonicity'])} "
            row += "|"
            lines.append(row)
        lines.append("")

    # 三、因子相关性分析
    lines.append("## 三、因子相关性分析")
    lines.append("")
    lines.append(f"对 35 个因子计算两两 Pearson 相关(全样本),识别 |corr| >= "
                 f"{correlation_result['threshold']} 的高相关因子对。")
    lines.append("")
    pairs = correlation_result["high_corr_pairs"]
    lines.append(f"**高相关因子对总数**: {len(pairs)}")
    lines.append("")
    if pairs:
        lines.append("### Top 20 高相关因子对")
        lines.append("")
        lines.append("| 因子1 | 因子2 | 相关系数 | 建议 |")
        lines.append("|------|------|----------|------|")
        for p in pairs[:20]:
            advice = "保留 |ICIR| 更高者" if abs(p["corr"]) >= 0.85 else "可考虑合并或保留一个"
            lines.append(f"| {p['f1']} | {p['f2']} | {p['corr']:.4f} | {advice} |")
        lines.append("")

    # 四、关键发现与建议
    lines.append("## 四、关键发现与建议")
    lines.append("")
    lines.append("### 4.1 多周期评估发现")
    lines.append("")

    # 找每个风格的最佳 horizon
    for style_id in list_style_ids():
        spec = STYLE_DEFINITIONS[style_id]
        results = multi_horizon_results[style_id]
        valid = [(h, r) for h, r in results.items() if r["spread"] is not None]
        if not valid:
            continue
        best_h, best_r = max(valid, key=lambda kv: kv[1]["spread"] or -1e9)
        default_h = spec.target_horizon
        default_r = results.get(default_h)
        if default_r and best_h != default_h:
            lines.append(f"- **{spec.style_name}**: 最佳 horizon={best_h}d "
                         f"(spread={_fmt_pct(best_r['spread'])}), "
                         f"原默认 {default_h}d spread={_fmt_pct(default_r['spread'])},"
                         f"建议改用 {best_h}d")
        elif default_r:
            lines.append(f"- **{spec.style_name}**: 最佳 horizon={best_h}d "
                         f"(spread={_fmt_pct(best_r['spread'])}), "
                         f"与默认一致")
    lines.append("")

    lines.append("### 4.2 分年度评估发现")
    lines.append("")
    for style_id in list_style_ids():
        spec = STYLE_DEFINITIONS[style_id]
        results = by_year_results[style_id]
        valid = [(y, r) for y, r in results.items() if r["spread"] is not None]
        if not valid:
            continue
        n_win = sum(1 for _, r in valid if r["spread"] > 0)
        n_total = len(valid)
        win_rate = n_win / n_total if n_total > 0 else 0
        lines.append(f"- **{spec.style_name}**: {n_win}/{n_total} 年 spread 为正 "
                     f"(胜率 {_fmt_pct(win_rate)})")
    lines.append("")

    lines.append("### 4.3 因子相关性发现")
    lines.append("")
    if pairs:
        lines.append(f"- 共 {len(pairs)} 对高相关因子(|corr| >= {correlation_result['threshold']})")
        # 统计涉及因子
        involved = set()
        for p in pairs:
            involved.add(p["f1"])
            involved.add(p["f2"])
        lines.append(f"- 涉及因子数: {len(involved)}")
        # 找超高相关对
        super_high = [p for p in pairs if abs(p["corr"]) >= 0.9]
        if super_high:
            lines.append(f"- 超高相关对 (|corr| >= 0.9): {len(super_high)} 对")
            for p in super_high[:5]:
                lines.append(f"  - {p['f1']} ↔ {p['f2']}: {p['corr']:.4f}")
    lines.append("")

    # 五、附录
    lines.append("## 五、附录")
    lines.append("")
    lines.append("### 5.1 风格的多周期测试范围")
    lines.append("")
    for style_id in list_style_ids():
        spec = STYLE_DEFINITIONS[style_id]
        horizons = STYLE_HORIZONS[style_id]
        lines.append(f"- **{spec.style_name}**: {horizons}")
    lines.append("")

    lines.append("---")
    lines.append("")
    lines.append(f"**报告生成**: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    lines.append(f"**评估脚本**: scripts/run_multi_horizon_year.py")
    lines.append(f"**min_icir**: {min_icir}")
    lines.append("")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text("\n".join(lines), encoding="utf-8")
    print(f"\n报告已保存: {output_path}")


# ========== Step 8: 主流程 ==========


def main() -> int:
    load_dotenv(EXPLORATION_ROOT / ".env")

    parser = argparse.ArgumentParser(description="P1: 多周期 + 分年度 + 相关性分析")
    parser.add_argument("--snapshot-root", default=os.environ.get("SNAPSHOT_ROOT", ""))
    parser.add_argument("--snapshot-id", default=os.environ.get("SNAPSHOT_ID", ""))
    parser.add_argument("--start", default=None)
    parser.add_argument("--end", default=None)
    parser.add_argument("--layers", type=int, default=None)
    parser.add_argument("--min-amount", type=float, default=None)
    parser.add_argument("--min-samples", type=int, default=None)
    parser.add_argument("--min-icir", type=float, default=2.0)
    parser.add_argument("--corr-threshold", type=float, default=0.7)
    parser.add_argument("--skip-by-year", action="store_true",
                        help="跳过分年度评估(耗时较长)")
    parser.add_argument("--output", default=None)
    args = parser.parse_args()

    cfg = load_config()
    eval_cfg = cfg.get("evaluation", {}) or {}
    duckdb_cfg = cfg.get("duckdb", {}) or {}

    snapshot_root = args.snapshot_root or eval_cfg.get("snapshot_root")
    if not snapshot_root:
        print("错误: 未指定 --snapshot-root", file=sys.stderr)
        return 1

    start = args.start or eval_cfg.get("default_start_date", "2021-07-25")
    end = args.end or eval_cfg.get("default_end_date", "2026-07-24")
    layers = args.layers or int(eval_cfg.get("default_layers", 5))
    min_amount = args.min_amount if args.min_amount is not None else float(
        eval_cfg.get("default_min_daily_amount", 10_000_000)
    )
    min_samples = args.min_samples or int(eval_cfg.get("default_min_samples", 30))
    threads = int(duckdb_cfg.get("threads", 4))
    max_memory = duckdb_cfg.get("max_memory", "2GB")

    print("=== P1: 多周期 + 分年度 + 相关性分析 ===")
    print(f"快照根: {snapshot_root}")
    print(f"日期范围: {start} ~ {end}")
    print(f"min_icir: {args.min_icir}")
    print(f"corr_threshold: {args.corr_threshold}")
    print(f"skip_by_year: {args.skip_by_year}")
    print()

    # 1. 收集所有需要的因子 ID
    existing_factor_ids = list_all_factor_ids()
    style_factor_ids = list_style_factor_ids()
    all_factor_ids = existing_factor_ids + style_factor_ids
    print(f"现有因子: {len(existing_factor_ids)}, 风格专属: {len(style_factor_ids)}, "
          f"合计: {len(all_factor_ids)}")

    # 2. 打开 DuckDB 会话, 加载 K 线
    snapshot_id_arg = args.snapshot_id or None
    active_snapshot_id = "unknown"
    with open_duckdb_session(
        snapshot_root, snapshot_id=snapshot_id_arg,
        threads=threads, max_memory=max_memory,
    ) as session:
        active_snapshot_id = session.snapshot.snapshot_id
        print(f"当前快照: {active_snapshot_id}")
        candles = load_candles(
            session, start_date=start, end_date=end,
            min_daily_amount=min_amount,
        )
        stock_count = candles["instrumentKey"].nunique() if not candles.empty else 0
        print(f"加载 {len(candles):,} 条 K 线, {stock_count:,} 只股票")
        print()

        if candles.empty:
            print("错误: 未加载到任何 K 线数据", file=sys.stderr)
            return 1

        # 3. 构造所有因子面板(只构造一次, 多周期/分年度共用)
        print("构造现有 27 个因子面板...")
        existing_panels = build_existing_factor_panels(candles, factor_ids=existing_factor_ids)
        n_valid_existing = sum(1 for p in existing_panels.values() if not p.empty)
        print(f"完成, 有效面板: {n_valid_existing}/{len(existing_factor_ids)}")

        print("构造 8 个新增风格专属因子面板...")
        style_panels = build_style_factor_panels(candles)
        n_valid_style = sum(1 for p in style_panels.values() if not p.empty)
        print(f"完成, 有效面板: {n_valid_style}/{len(style_factor_ids)}")

        all_panels = {**existing_panels, **style_panels}
        print(f"合并后面板数: {len(all_panels)}")
        print()

        # 4. 多周期评估
        multi_horizon_results = run_multi_horizon_eval(
            style_results_baseline={},
            all_panels=all_panels,
            candles_long=candles,
            layers=layers,
            min_samples=min_samples,
            min_icir=args.min_icir,
        )

        # 5. 分年度评估
        if args.skip_by_year:
            print("\n跳过分年度评估 (--skip-by-year)")
            by_year_results = {sid: {} for sid in list_style_ids()}
        else:
            by_year_results = run_by_year_eval(
                all_panels=all_panels,
                candles_long=candles,
                layers=layers,
                min_samples=min_samples,
                min_icir=args.min_icir,
            )

        # 6. 因子相关性分析
        correlation_result = run_factor_correlation_analysis(
            all_panels=all_panels,
            threshold=args.corr_threshold,
        )

    # 7. 生成报告
    if args.output:
        output_path = Path(args.output)
    else:
        output_path = Path("d:/github_public_repo/量化回测/tmp_output/STYLE_COMPARISON_REPORT_V3.md")

    build_v3_report(
        multi_horizon_results=multi_horizon_results,
        by_year_results=by_year_results,
        correlation_result=correlation_result,
        candles_count=len(candles),
        stock_count=stock_count,
        date_range=(start, end),
        snapshot_id=active_snapshot_id,
        min_icir=args.min_icir,
        output_path=output_path,
    )

    # 8. 保存详细数据 JSON
    data_path = output_path.parent / f"{output_path.stem}_data.json"
    data = {
        "_meta": {
            "min_icir": args.min_icir,
            "corr_threshold": args.corr_threshold,
            "date_range": [start, end],
            "snapshot_id": active_snapshot_id,
        },
        "multi_horizon": {
            sid: {str(h): r for h, r in results.items()}
            for sid, results in multi_horizon_results.items()
        },
        "by_year": {
            sid: {str(y): r for y, r in results.items()}
            for sid, results in by_year_results.items()
        },
        "correlation": {
            "threshold": correlation_result["threshold"],
            "high_corr_pairs": correlation_result["high_corr_pairs"],
        },
    }
    data_path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"详细数据已保存: {data_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
