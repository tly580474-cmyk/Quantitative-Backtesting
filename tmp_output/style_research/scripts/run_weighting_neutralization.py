"""P2: 等权 vs ICIR 加权对比 + 市值中性化评估。

输出:
- STYLE_COMPARISON_REPORT_V4.md: 加权方式对比表 + 中性化前后对比表

用法:
    python scripts/run_weighting_neutralization.py --min-icir 2.0
"""

from __future__ import annotations

import argparse
import importlib.util
import os
import sys
from dataclasses import replace
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd
import yaml
from dotenv import load_dotenv

# ========== 引导导入 ==========

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

# ========== 业务模块 ==========

from src.data import load_candles, open_duckdb_session  # noqa: E402
from src.factors.registry import list_all_factor_ids  # noqa: E402
from src.factors.style_specific import list_style_factor_ids  # noqa: E402
from src.panel.vectorized import (  # noqa: E402
    build_all_factor_panels_vectorized as build_existing_factor_panels,
)
from src.panel.vectorized_styles import (  # noqa: E402
    build_all_style_factor_panels_vectorized as build_style_factor_panels,
)
from src.styles import STYLE_DEFINITIONS, StyleScorer, list_style_ids  # noqa: E402


# ========== 配置 ==========


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


# 风格最佳 horizon (来自 V3 多周期评估)
STYLE_BEST_HORIZON: dict[str, int] = {
    "contrarian": 20,
    "value": 60,
    "growth": 60,
    "trend": 60,
    "short_term": 10,
}


# ========== 市值中性化 ==========


def neutralize_by_market_cap(
    factor_panel: pd.DataFrame,
    market_cap_panel: pd.DataFrame,
) -> pd.DataFrame:
    """对因子面板做市值中性化(横截面回归残差)。

    对每个 tradeDate, 将因子值对 log(market_cap) 做线性回归, 取残差作为中性化后的因子值。
    """
    if factor_panel.empty or market_cap_panel.empty:
        return factor_panel.copy()

    # 对齐 index 和 columns
    common_dates = factor_panel.index.intersection(market_cap_panel.index)
    common_cols = factor_panel.columns.intersection(market_cap_panel.columns)
    if len(common_dates) == 0 or len(common_cols) == 0:
        return factor_panel.copy()

    fp = factor_panel.loc[common_dates, common_cols]
    mp = market_cap_panel.loc[common_dates, common_cols]
    result = fp.copy()

    # 对每个日期做横截面回归
    for date in common_dates:
        f_row = fp.loc[date].values
        m_row = mp.loc[date].values
        mask = np.isfinite(f_row) & np.isfinite(m_row)
        n = mask.sum()
        if n < 30:
            continue
        # 简单 OLS: f = a + b*m + e, 取残差 e
        x = m_row[mask]
        y = f_row[mask]
        x_mean = x.mean()
        y_mean = y.mean()
        x_centered = x - x_mean
        denom = (x_centered ** 2).sum()
        if denom == 0:
            continue
        b = ((x_centered) * (y - y_mean)).sum() / denom
        a = y_mean - b * x_mean
        residuals = y - (a + b * x)
        # 写回原 row
        new_row = np.full_like(f_row, np.nan)
        new_row[mask] = residuals
        result.loc[date] = new_row

    return result


def neutralize_all_panels(
    all_panels: dict[str, pd.DataFrame],
    market_cap_id: str = "log_market_cap",
) -> dict[str, pd.DataFrame]:
    """对全部因子面板做市值中性化(除了 market_cap 本身)。"""
    if market_cap_id not in all_panels:
        print(f"  警告: 缺少 {market_cap_id}, 跳过中性化")
        return all_panels

    mp = all_panels[market_cap_id]
    if mp.empty:
        print(f"  警告: {market_cap_id} 面板为空, 跳过中性化")
        return all_panels

    print(f"  对 {len(all_panels) - 1} 个因子做市值中性化(基准: {market_cap_id})...")
    neutralized: dict[str, pd.DataFrame] = {}
    for fid, panel in all_panels.items():
        if fid == market_cap_id or fid == "log_float_market_cap":
            # 市值因子本身不做中性化, 直接保留(或置空)
            neutralized[fid] = panel.copy()
            continue
        if panel.empty:
            neutralized[fid] = panel
            continue
        neutralized[fid] = neutralize_by_market_cap(panel, mp)
    neutralized[market_cap_id] = mp.copy()
    print(f"  中性化完成, 共 {len(neutralized)} 个面板")
    return neutralized


# ========== 加权方式对比 ==========


def run_weighting_comparison(
    all_panels: dict[str, pd.DataFrame],
    candles_long: pd.DataFrame,
    layers: int,
    min_samples: int,
    min_icir: float,
) -> dict[str, dict[str, dict]]:
    """对每个风格 × 每种加权方式 (icir, equal) 在最佳 horizon 下评估。"""
    print("\n=== 加权方式对比 (ICIR vs Equal) ===")
    results: dict[str, dict[str, dict]] = {}

    for style_id in list_style_ids():
        spec = STYLE_DEFINITIONS[style_id]
        best_h = STYLE_BEST_HORIZON[style_id]
        print(f"\n风格: {spec.style_name} ({style_id}), horizon={best_h}d")

        results[style_id] = {}
        for weighting in ("icir", "equal"):
            temp_spec = replace(
                spec,
                target_horizon=best_h,
                weight_horizon=best_h,
                weighting=weighting,
            )
            scorer = StyleScorer(temp_spec)
            result = scorer.evaluate(
                all_factor_panels=all_panels,
                candles_long=candles_long,
                layers=layers,
                min_samples=min_samples,
                min_icir=min_icir,
            )
            cr = result.composite_report
            results[style_id][weighting] = {
                "spread": cr.long_short_spread,
                "monotonicity": cr.monotonicity,
                "l1": cr.layers[0].average_return if cr.layers else None,
                "l5": cr.layers[-1].average_return if cr.layers else None,
                "n_selected": len(result.selected_factor_ids),
                "n_dropped": len(result.dropped_factors),
            }
            print(f"  {weighting:>6s}: spread={_fmt_pct(cr.long_short_spread)}, "
                  f"mono={_fmt_float(cr.monotonicity)}, "
                  f"保留={len(result.selected_factor_ids)}")

    return results


# ========== 中性化前后对比 ==========


def run_neutralization_comparison(
    all_panels: dict[str, pd.DataFrame],
    candles_long: pd.DataFrame,
    layers: int,
    min_samples: int,
    min_icir: float,
) -> dict[str, dict[str, dict]]:
    """对每个风格, 在中性化前后做对比评估。"""
    print("\n=== 市值中性化前后对比 ===")
    results: dict[str, dict[str, dict]] = {}

    # 中性化后的因子面板
    neutralized_panels = neutralize_all_panels(all_panels)

    for style_id in list_style_ids():
        spec = STYLE_DEFINITIONS[style_id]
        best_h = STYLE_BEST_HORIZON[style_id]
        print(f"\n风格: {spec.style_name} ({style_id}), horizon={best_h}d")

        temp_spec = replace(spec, target_horizon=best_h, weight_horizon=best_h)
        results[style_id] = {}

        # 原始(未中性化)
        scorer = StyleScorer(temp_spec)
        result = scorer.evaluate(
            all_factor_panels=all_panels,
            candles_long=candles_long,
            layers=layers,
            min_samples=min_samples,
            min_icir=min_icir,
        )
        cr = result.composite_report
        results[style_id]["raw"] = {
            "spread": cr.long_short_spread,
            "monotonicity": cr.monotonicity,
            "l1": cr.layers[0].average_return if cr.layers else None,
            "l5": cr.layers[-1].average_return if cr.layers else None,
            "n_selected": len(result.selected_factor_ids),
            "n_dropped": len(result.dropped_factors),
        }
        print(f"  原始: spread={_fmt_pct(cr.long_short_spread)}, "
              f"mono={_fmt_float(cr.monotonicity)}, "
              f"保留={len(result.selected_factor_ids)}")

        # 中性化后
        scorer_neut = StyleScorer(temp_spec)
        result_neut = scorer_neut.evaluate(
            all_factor_panels=neutralized_panels,
            candles_long=candles_long,
            layers=layers,
            min_samples=min_samples,
            min_icir=min_icir,
        )
        cr_neut = result_neut.composite_report
        results[style_id]["neutralized"] = {
            "spread": cr_neut.long_short_spread,
            "monotonicity": cr_neut.monotonicity,
            "l1": cr_neut.layers[0].average_return if cr_neut.layers else None,
            "l5": cr_neut.layers[-1].average_return if cr_neut.layers else None,
            "n_selected": len(result_neut.selected_factor_ids),
            "n_dropped": len(result_neut.dropped_factors),
        }
        print(f"  中性: spread={_fmt_pct(cr_neut.long_short_spread)}, "
              f"mono={_fmt_float(cr_neut.monotonicity)}, "
              f"保留={len(result_neut.selected_factor_ids)}")

    return results


# ========== 报告生成 ==========


def build_v4_report(
    weighting_results: dict[str, dict[str, dict]],
    neutralization_results: dict[str, dict[str, dict]],
    candles_count: int,
    stock_count: int,
    date_range: tuple[str, str],
    snapshot_id: str,
    min_icir: float,
    output_path: Path,
) -> None:
    """生成 V4 综合报告。"""
    lines: list[str] = []
    lines.append("# 多风格选股评分对比研究报告 (V4 - 加权方式 + 市值中性化)")
    lines.append("")
    lines.append(f"**生成时间**: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    lines.append(f"**评估范围**: {date_range[0]} ~ {date_range[1]}")
    lines.append(f"**数据源**: DuckDB 研究快照 `{snapshot_id}`")
    lines.append(f"**样本规模**: {stock_count:,} 只 A 股主板股票 × "
                 f"~{candles_count // max(stock_count, 1):,} 个交易日 ≈ {candles_count:,} 条 K 线")
    lines.append(f"**min_icir**: {min_icir} (剔除 |rank_ic_ir| < {min_icir} 的弱因子)")
    lines.append(f"**评估 horizon**: 各风格在 V3 多周期评估得出的最佳 horizon")
    lines.append("")

    # 一、加权方式对比
    lines.append("## 一、加权方式对比 (ICIR 加权 vs 等权)")
    lines.append("")
    lines.append("在每个风格的最佳 horizon 下,对比两种加权方式:")
    lines.append("- **ICIR 加权**: 权重 = |rank_ic_ir|, 突出预测能力强的因子")
    lines.append("- **等权**: 权重 = 1/N, 给所有因子相同的话语权")
    lines.append("")

    # 总览表
    lines.append("### 1.1 总览")
    lines.append("")
    lines.append("| 风格 | horizon | "
                 "ICIR spread | ICIR mono | ICIR 保留 | "
                 "Equal spread | Equal mono | Equal 保留 | "
                 "Spread 差值 | 推荐 |")
    lines.append("|------|---------|"
                 "-----------|-----------|-----------|"
                 "-------------|-------------|-------------|"
                 "------------|------|")
    for style_id in list_style_ids():
        spec = STYLE_DEFINITIONS[style_id]
        h = STYLE_BEST_HORIZON[style_id]
        icir_r = weighting_results[style_id]["icir"]
        eq_r = weighting_results[style_id]["equal"]
        spread_diff = (icir_r["spread"] - eq_r["spread"]) if (
            icir_r["spread"] is not None and eq_r["spread"] is not None
        ) else None
        if spread_diff is not None and spread_diff > 0:
            rec = "ICIR"
        elif spread_diff is not None and spread_diff < 0:
            rec = "Equal"
        else:
            rec = "持平"
        lines.append(
            f"| {spec.style_name} | {h}d | "
            f"{_fmt_pct(icir_r['spread'])} | {_fmt_float(icir_r['monotonicity'])} | "
            f"{icir_r['n_selected']} | "
            f"{_fmt_pct(eq_r['spread'])} | {_fmt_float(eq_r['monotonicity'])} | "
            f"{eq_r['n_selected']} | "
            f"{_fmt_pct(spread_diff)} | {rec} |"
        )
    lines.append("")

    # 单风格详情
    lines.append("### 1.2 单风格详情")
    lines.append("")
    for style_id in list_style_ids():
        spec = STYLE_DEFINITIONS[style_id]
        h = STYLE_BEST_HORIZON[style_id]
        icir_r = weighting_results[style_id]["icir"]
        eq_r = weighting_results[style_id]["equal"]
        lines.append(f"#### {spec.style_name} (h={h}d)")
        lines.append("")
        lines.append("| 加权方式 | 层1收益 | 层5收益 | 多空价差 | 单调性 | 保留因子 |")
        lines.append("|---------|---------|---------|----------|--------|----------|")
        lines.append(f"| ICIR 加权 | {_fmt_pct(icir_r['l1'])} | "
                     f"{_fmt_pct(icir_r['l5'])} | "
                     f"{_fmt_pct(icir_r['spread'])} | "
                     f"{_fmt_float(icir_r['monotonicity'])} | "
                     f"{icir_r['n_selected']} |")
        lines.append(f"| 等权     | {_fmt_pct(eq_r['l1'])} | "
                     f"{_fmt_pct(eq_r['l5'])} | "
                     f"{_fmt_pct(eq_r['spread'])} | "
                     f"{_fmt_float(eq_r['monotonicity'])} | "
                     f"{eq_r['n_selected']} |")
        lines.append("")

    # 二、市值中性化
    lines.append("## 二、市值中性化前后对比")
    lines.append("")
    lines.append("对每个因子做横截面市值中性化(对 log(market_cap) 回归取残差),"
                 "评估中性化前后风格表现的稳定性。")
    lines.append("")
    lines.append("- **原始**: 未做中性化, 因子可能受市值因子污染")
    lines.append("- **中性化**: 对每个 tradeDate 横截面回归 f = a + b·log(mcap) + e, 取残差 e")
    lines.append("")

    # 总览表
    lines.append("### 2.1 总览")
    lines.append("")
    lines.append("| 风格 | horizon | "
                 "原始 spread | 原始 mono | 原始保留 | "
                 "中性 spread | 中性 mono | 中性保留 | "
                 "Spread 变化 | 评估 |")
    lines.append("|------|---------|"
                 "-----------|-----------|-----------|"
                 "-----------|-----------|-----------|"
                 "------------|------|")
    for style_id in list_style_ids():
        spec = STYLE_DEFINITIONS[style_id]
        h = STYLE_BEST_HORIZON[style_id]
        raw_r = neutralization_results[style_id]["raw"]
        neu_r = neutralization_results[style_id]["neutralized"]
        delta = (neu_r["spread"] - raw_r["spread"]) if (
            neu_r["spread"] is not None and raw_r["spread"] is not None
        ) else None
        if delta is not None and delta > 0.001:
            assess = "中性化后提升"
        elif delta is not None and delta < -0.001:
            assess = "中性化后下降"
        else:
            assess = "影响有限"
        lines.append(
            f"| {spec.style_name} | {h}d | "
            f"{_fmt_pct(raw_r['spread'])} | {_fmt_float(raw_r['monotonicity'])} | "
            f"{raw_r['n_selected']} | "
            f"{_fmt_pct(neu_r['spread'])} | {_fmt_float(neu_r['monotonicity'])} | "
            f"{neu_r['n_selected']} | "
            f"{_fmt_pct(delta)} | {assess} |"
        )
    lines.append("")

    # 单风格详情
    lines.append("### 2.2 单风格详情")
    lines.append("")
    for style_id in list_style_ids():
        spec = STYLE_DEFINITIONS[style_id]
        h = STYLE_BEST_HORIZON[style_id]
        raw_r = neutralization_results[style_id]["raw"]
        neu_r = neutralization_results[style_id]["neutralized"]
        lines.append(f"#### {spec.style_name} (h={h}d)")
        lines.append("")
        lines.append("| 状态 | 层1收益 | 层5收益 | 多空价差 | 单调性 | 保留因子 |")
        lines.append("|------|---------|---------|----------|--------|----------|")
        lines.append(f"| 原始  | {_fmt_pct(raw_r['l1'])} | "
                     f"{_fmt_pct(raw_r['l5'])} | "
                     f"{_fmt_pct(raw_r['spread'])} | "
                     f"{_fmt_float(raw_r['monotonicity'])} | "
                     f"{raw_r['n_selected']} |")
        lines.append(f"| 中性化 | {_fmt_pct(neu_r['l1'])} | "
                     f"{_fmt_pct(neu_r['l5'])} | "
                     f"{_fmt_pct(neu_r['spread'])} | "
                     f"{_fmt_float(neu_r['monotonicity'])} | "
                     f"{neu_r['n_selected']} |")
        lines.append("")

    # 三、关键发现
    lines.append("## 三、关键发现与建议")
    lines.append("")

    # 加权方式发现
    lines.append("### 3.1 加权方式选择")
    lines.append("")
    n_icir_better = 0
    n_equal_better = 0
    for style_id in list_style_ids():
        icir_s = weighting_results[style_id]["icir"]["spread"] or 0
        eq_s = weighting_results[style_id]["equal"]["spread"] or 0
        if icir_s > eq_s:
            n_icir_better += 1
        elif eq_s > icir_s:
            n_equal_better += 1
    lines.append(f"- ICIR 加权更优的风格数: {n_icir_better}/5")
    lines.append(f"- 等权更优的风格数: {n_equal_better}/5")
    if n_icir_better > n_equal_better:
        lines.append("- **结论**: 整体上 ICIR 加权更优, 推荐作为默认加权方式")
    elif n_equal_better > n_icir_better:
        lines.append("- **结论**: 整体上等权更优, 但差异较小, 推荐对小样本风格用等权")
    else:
        lines.append("- **结论**: 两种加权方式各有优势, 建议按风格选择")
    lines.append("")

    # 中性化发现
    lines.append("### 3.2 市值中性化效果")
    lines.append("")
    n_improved = 0
    n_declined = 0
    for style_id in list_style_ids():
        raw_s = neutralization_results[style_id]["raw"]["spread"] or 0
        neu_s = neutralization_results[style_id]["neutralized"]["spread"] or 0
        if neu_s > raw_s + 0.001:
            n_improved += 1
        elif neu_s < raw_s - 0.001:
            n_declined += 1
    lines.append(f"- 中性化后 spread 提升的风格数: {n_improved}/5")
    lines.append(f"- 中性化后 spread 下降的风格数: {n_declined}/5")
    if n_improved > n_declined:
        lines.append("- **结论**: 市值中性化整体有效, 推荐作为标准化处理步骤")
    elif n_declined > n_improved:
        lines.append("- **结论**: 市值中性化整体效果为负, 风格已隐含市值因子, 不必额外中性化")
    else:
        lines.append("- **结论**: 市值中性化效果因风格而异, 建议按风格选择是否中性化")
    lines.append("")

    # 四、附录
    lines.append("## 四、附录")
    lines.append("")
    lines.append("### 4.1 各风格的最佳 horizon (来自 V3)")
    lines.append("")
    for style_id in list_style_ids():
        spec = STYLE_DEFINITIONS[style_id]
        h = STYLE_BEST_HORIZON[style_id]
        lines.append(f"- **{spec.style_name}**: {h}d")
    lines.append("")

    lines.append("---")
    lines.append("")
    lines.append(f"**报告生成**: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    lines.append(f"**评估脚本**: scripts/run_weighting_neutralization.py")
    lines.append(f"**min_icir**: {min_icir}")
    lines.append("")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text("\n".join(lines), encoding="utf-8")
    print(f"\n报告已保存: {output_path}")


# ========== 主流程 ==========


def main() -> int:
    load_dotenv(EXPLORATION_ROOT / ".env")

    parser = argparse.ArgumentParser(description="P2: 加权方式 + 市值中性化")
    parser.add_argument("--snapshot-root", default=os.environ.get("SNAPSHOT_ROOT", ""))
    parser.add_argument("--snapshot-id", default=os.environ.get("SNAPSHOT_ID", ""))
    parser.add_argument("--start", default=None)
    parser.add_argument("--end", default=None)
    parser.add_argument("--layers", type=int, default=None)
    parser.add_argument("--min-amount", type=float, default=None)
    parser.add_argument("--min-samples", type=int, default=None)
    parser.add_argument("--min-icir", type=float, default=2.0)
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

    print("=== P2: 加权方式 + 市值中性化 ===")
    print(f"快照根: {snapshot_root}")
    print(f"日期范围: {start} ~ {end}")
    print(f"min_icir: {args.min_icir}")
    print()

    existing_factor_ids = list_all_factor_ids()
    style_factor_ids = list_style_factor_ids()
    print(f"现有因子: {len(existing_factor_ids)}, 风格专属: {len(style_factor_ids)}, "
          f"合计: {len(existing_factor_ids) + len(style_factor_ids)}")

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

        # 构造所有因子面板
        print("构造现有 27 个因子面板...")
        existing_panels = build_existing_factor_panels(candles, factor_ids=existing_factor_ids)
        print(f"完成, 有效面板: {sum(1 for p in existing_panels.values() if not p.empty)}/27")

        print("构造 8 个新增风格专属因子面板...")
        style_panels = build_style_factor_panels(candles)
        print(f"完成, 有效面板: {sum(1 for p in style_panels.values() if not p.empty)}/8")

        all_panels = {**existing_panels, **style_panels}
        print(f"合并后面板数: {len(all_panels)}")
        print()

        # 1. 加权方式对比
        weighting_results = run_weighting_comparison(
            all_panels=all_panels,
            candles_long=candles,
            layers=layers,
            min_samples=min_samples,
            min_icir=args.min_icir,
        )

        # 2. 市值中性化前后对比
        neutralization_results = run_neutralization_comparison(
            all_panels=all_panels,
            candles_long=candles,
            layers=layers,
            min_samples=min_samples,
            min_icir=args.min_icir,
        )

    # 3. 生成报告
    if args.output:
        output_path = Path(args.output)
    else:
        output_path = Path("d:/github_public_repo/量化回测/tmp_output/STYLE_COMPARISON_REPORT_V4.md")

    build_v4_report(
        weighting_results=weighting_results,
        neutralization_results=neutralization_results,
        candles_count=len(candles),
        stock_count=stock_count,
        date_range=(start, end),
        snapshot_id=active_snapshot_id,
        min_icir=args.min_icir,
        output_path=output_path,
    )

    # 4. 保存详细数据
    import json
    data_path = output_path.parent / f"{output_path.stem}_data.json"
    data = {
        "_meta": {
            "min_icir": args.min_icir,
            "date_range": [start, end],
            "snapshot_id": active_snapshot_id,
        },
        "weighting": {
            sid: {w: r for w, r in results.items()}
            for sid, results in weighting_results.items()
        },
        "neutralization": {
            sid: {k: r for k, r in results.items()}
            for sid, results in neutralization_results.items()
        },
        "best_horizons": STYLE_BEST_HORIZON,
    }
    data_path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"详细数据已保存: {data_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
