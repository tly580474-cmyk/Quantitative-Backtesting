"""5 种投资风格评分对比评估脚本。

流程:
1. 引导导入(将 style_research 模块注入 src.* 命名空间)
2. 加载 K 线(从 DuckDB 快照)
3. 构造 35 个因子面板(现有 27 + 新增 8 风格专属)
4. 对每种风格运行 StyleScorer.evaluate(支持 auto_calibrate + min_icir)
5. 生成对比报告(Markdown)

用法:
    python scripts/run_style_comparison.py                          # V2 默认
    python scripts/run_style_comparison.py --min-icir 0            # 不剔除弱因子
    python scripts/run_style_comparison.py --start 2023-01-01 --end 2026-07-24
    python scripts/run_style_comparison.py --output report.md      # 指定输出
"""

from __future__ import annotations

import argparse
import importlib.util
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import yaml
from dotenv import load_dotenv

# ========== Step 1: 引导导入 ==========

STYLE_RESEARCH_ROOT = Path(__file__).resolve().parent.parent
EXPLORATION_ROOT = Path("d:/github_public_repo/评分规则探索")

# sys.path 只加 评分规则探索 (style_research 通过 importlib 注入)
if str(EXPLORATION_ROOT) not in sys.path:
    sys.path.insert(0, str(EXPLORATION_ROOT))

# 导入 src 基础包
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


# 注入 style_research 模块
_style_src = STYLE_RESEARCH_ROOT / "src"
_load_package(
    _style_src / "factors" / "style_specific" / "__init__.py",
    "src.factors.style_specific",
)
_load_module(
    _style_src / "panel" / "vectorized_styles.py",
    "src.panel.vectorized_styles",
)
_load_package(
    _style_src / "styles" / "__init__.py",
    "src.styles",
)

# ========== Step 2: 导入业务模块 ==========

from src.data import load_candles, open_duckdb_session  # noqa: E402
from src.factors.registry import (  # noqa: E402
    DEFAULT_REGISTRY,
    list_all_factor_ids,
)
from src.factors.style_specific import (  # noqa: E402
    STYLE_SPECIFIC_FACTORS,
    list_style_factor_ids,
)
from src.panel.vectorized import (  # noqa: E402
    build_all_factor_panels_vectorized as build_existing_factor_panels,
)
from src.panel.vectorized_styles import (  # noqa: E402
    build_all_style_factor_panels_vectorized as build_style_factor_panels,
)
from src.styles import (  # noqa: E402
    STYLE_DEFINITIONS,
    StyleScorer,
    list_style_ids,
)


# ========== Step 3: 配置加载 ==========


def load_config() -> dict:
    load_dotenv(EXPLORATION_ROOT / ".env")
    config_path = EXPLORATION_ROOT / "config.yaml"
    if not config_path.exists():
        return {}
    with open(config_path, "r", encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


# ========== Step 4: 报告生成 ==========


def _fmt_pct(v: float | None) -> str:
    if v is None:
        return "N/A"
    return f"{v * 100:.4f}%"


def _fmt_float(v: float | None, digits: int = 4) -> str:
    if v is None:
        return "N/A"
    return f"{v:.{digits}f}"


def _build_style_summary_row(style_id: str, result) -> str:
    """构造风格汇总表的一行。"""
    spec = result.style_spec
    cr = result.composite_report
    spread = cr.long_short_spread
    mono = cr.monotonicity
    layers = cr.layers
    l1 = layers[0].average_return if layers else None
    l5 = layers[-1].average_return if layers else None
    n_factors_total = len(spec.factor_ids)
    n_selected = len(result.selected_factor_ids)
    n_dropped = len(result.dropped_factors)

    return (
        f"| {spec.style_name} | {spec.risk_level} | {spec.target_horizon}d | "
        f"{n_factors_total}→{n_selected} (剔{n_dropped}) | "
        f"{_fmt_pct(l1)} | {_fmt_pct(l5)} | "
        f"{_fmt_pct(spread)} | {_fmt_float(mono)} | "
        f"{'是' if spec.auto_calibrate else '否'} |"
    )


def _build_style_detail_section(result) -> list[str]:
    """构造单风格的详细章节。"""
    spec = result.style_spec
    cr = result.composite_report
    lines: list[str] = []
    lines.append(f"### {spec.style_name} ({spec.style_id})")
    lines.append("")
    lines.append(f"- **风险等级**: {spec.risk_level}")
    lines.append(f"- **目标持有期**: {spec.target_horizon} 日")
    lines.append(f"- **权重计算 horizon**: {spec.weight_horizon} 日")
    lines.append(f"- **原因子数**: {len(spec.factor_ids)}")
    lines.append(f"- **校准后因子数**: {len(result.selected_factor_ids)}")
    lines.append(f"- **剔除因子数**: {len(result.dropped_factors)}")
    lines.append(f"- **方向校准**: {'启用(auto_calibrate)' if spec.auto_calibrate else '关闭(用主观方向)'}")
    lines.append(f"- **描述**: {spec.description}")
    lines.append("")

    # 剔除因子列表
    if result.dropped_factors:
        lines.append("#### 被剔除的因子")
        lines.append("")
        lines.append("| 因子 | 剔除原因 |")
        lines.append("|------|----------|")
        for fid, reason in result.dropped_factors.items():
            lines.append(f"| {fid} | {reason} |")
        lines.append("")

    # 复合评分分层
    lines.append("#### 复合评分分层收益")
    lines.append("")
    lines.append("| 层级 | 样本数 | 平均收益 |")
    lines.append("|------|--------|----------|")
    for m in cr.layers:
        avg_ret = _fmt_pct(m.average_return)
        lines.append(f"| {m.layer} | {m.sample_count} | {avg_ret} |")
    lines.append("")
    spread = cr.long_short_spread
    mono = cr.monotonicity
    lines.append(f"- **多空价差**: {_fmt_pct(spread)}")
    lines.append(f"- **单调性**: {_fmt_float(mono)}")
    lines.append("")

    # 单因子 IC/ICIR 表(按 |rank_ic_ir| 降序)
    lines.append("#### 单因子 IC/ICIR (按 |rank_ic_ir| 降序)")
    lines.append("")
    lines.append("| 因子 | 主观方向 | 校准方向 | avg_rank_ic | rank_ic_ir | IC 正向率 | 多空价差 | 单调性 | 权重 |")
    lines.append("|------|----------|----------|-------------|------------|----------|----------|--------|------|")

    sorted_reports = sorted(
        result.factor_reports.items(),
        key=lambda kv: abs(kv[1].ic_summary.rank_ic_ir or 0),
        reverse=True,
    )
    for fid, r in sorted_reports:
        ic = r.ic_summary
        lr = r.layered_report
        weight = result.weights.get(fid, 0.0)
        subjective_dir = spec.directions.get(fid, "research")
        calibrated_dir = result.calibrated_directions.get(fid, "research")
        direction_changed = "🔄" if subjective_dir != calibrated_dir else ""
        avg_rank_ic = ic.average_rank_ic
        rank_ic_ir = ic.rank_ic_ir
        ic_pos_rate = ic.rank_ic_positive_rate
        ls_spread = lr.long_short_spread
        ls_mono = lr.monotonicity
        lines.append(
            f"| {fid} | {subjective_dir} | {calibrated_dir}{direction_changed} | "
            f"{_fmt_float(avg_rank_ic)} | "
            f"{_fmt_float(rank_ic_ir, 2)} | "
            f"{_fmt_pct(ic_pos_rate / 100.0) if ic_pos_rate is not None else 'N/A'} | "
            f"{_fmt_pct(ls_spread)} | "
            f"{_fmt_float(ls_mono)} | "
            f"{_fmt_float(weight)} |"
        )
    lines.append("")

    return lines


def build_report(
    style_results: dict,
    candles_count: int,
    stock_count: int,
    date_range: tuple[str, str],
    snapshot_id: str,
    output_path: Path,
    min_icir: float = 0.0,
) -> None:
    """生成完整对比报告 Markdown。"""
    lines: list[str] = []
    lines.append("# 多风格选股评分对比研究报告 (V2 - 方向校准 + 弱因子剔除)")
    lines.append("")
    lines.append(f"**生成时间**: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    lines.append(f"**评估范围**: {date_range[0]} ~ {date_range[1]}")
    lines.append(f"**数据源**: DuckDB 研究快照 `{snapshot_id}`")
    lines.append(f"**样本规模**: {stock_count:,} 只 A 股主板股票 × "
                 f"~{candles_count // max(stock_count, 1):,} 个交易日 ≈ {candles_count:,} 条 K 线")
    lines.append(f"**风格数**: {len(style_results)} 种")
    lines.append(f"**评估方法**: T+1 开盘 → T+H 收盘 forward return,5 分层,"
                 f"|rank_ic_ir| 加权复合,zscore 标准化 (clip ±3σ)")
    lines.append(f"**P0 增强**: auto_calibrate (按 avg_rank_ic 符号校准方向), "
                 f"min_icir={min_icir} (剔除 |rank_ic_ir| < {min_icir} 的弱因子)")
    lines.append("")

    # 一、风格总览
    lines.append("## 一、风格总览")
    lines.append("")
    lines.append("| 风格 | 风险等级 | 持有期 | 因子数(剔后) | "
                 "层1收益 | 层5收益 | 多空价差 | 单调性 | 方向校准 |")
    lines.append("|------|----------|--------|--------------|"
                 "----------|----------|----------|--------|----------|")
    for style_id in list_style_ids():
        result = style_results[style_id]
        lines.append(_build_style_summary_row(style_id, result))
    lines.append("")

    # 二、单风格详情
    lines.append("## 二、单风格详情")
    lines.append("")
    for style_id in list_style_ids():
        result = style_results[style_id]
        lines.extend(_build_style_detail_section(result))

    # 三、横向对比与结论
    lines.append("## 三、横向对比与关键发现")
    lines.append("")

    # 找出多空价差最大的风格
    best_spread_style = max(
        style_results.values(),
        key=lambda r: r.composite_report.long_short_spread or -1e9,
    )
    worst_spread_style = min(
        style_results.values(),
        key=lambda r: r.composite_report.long_short_spread or 1e9,
    )
    best_mono_style = max(
        style_results.values(),
        key=lambda r: abs(r.composite_report.monotonicity or 0),
    )

    lines.append("### 3.1 多空价差对比")
    lines.append("")
    lines.append(f"- **多空价差最大**: {best_spread_style.style_spec.style_name} "
                 f"({_fmt_pct(best_spread_style.composite_report.long_short_spread)})")
    lines.append(f"- **多空价差最小**: {worst_spread_style.style_spec.style_name} "
                 f"({_fmt_pct(worst_spread_style.composite_report.long_short_spread)})")
    lines.append(f"- **单调性最强**: {best_mono_style.style_spec.style_name} "
                 f"({_fmt_float(best_mono_style.composite_report.monotonicity)})")
    lines.append("")

    # 各风格层 5 收益对比(理想情况下层 5 应大于层 1)
    lines.append("### 3.2 各风格层 5 收益对比(理想: 高分股票收益更高)")
    lines.append("")
    lines.append("| 风格 | 持有期 | 层1 | 层5 | 层5-层1 |")
    lines.append("|------|--------|-----|-----|---------|")
    for style_id in list_style_ids():
        r = style_results[style_id]
        cr = r.composite_report
        l1 = cr.layers[0].average_return if cr.layers else None
        l5 = cr.layers[-1].average_return if cr.layers else None
        diff = (l5 - l1) if (l1 is not None and l5 is not None) else None
        lines.append(
            f"| {r.style_spec.style_name} | {r.style_spec.target_horizon}d | "
            f"{_fmt_pct(l1)} | {_fmt_pct(l5)} | {_fmt_pct(diff)} |"
        )
    lines.append("")

    # 各风格方向有效性(用校准后的方向计算一致率)
    lines.append("### 3.3 风格方向标注 vs 实际 IC 方向 (校准后)")
    lines.append("")
    lines.append("| 风格 | 因子数 | 主观一致 | 校准一致 | 主观一致率 | 校准一致率 | 校准改变数 |")
    lines.append("|------|--------|----------|----------|------------|------------|------------|")
    for style_id in list_style_ids():
        r = style_results[style_id]
        spec = r.style_spec
        n_total = 0
        n_subjective_consistent = 0
        n_calibrated_consistent = 0
        n_changed = 0
        for fid, report in r.factor_reports.items():
            rank_ic = report.ic_summary.average_rank_ic
            if rank_ic is None:
                continue
            n_total += 1
            subjective_dir = spec.directions.get(fid, "research")
            calibrated_dir = r.calibrated_directions.get(fid, "research")
            if subjective_dir != calibrated_dir and subjective_dir != "research":
                n_changed += 1
            # 主观一致
            if subjective_dir == "higher-is-better" and rank_ic > 0:
                n_subjective_consistent += 1
            elif subjective_dir == "lower-is-better" and rank_ic < 0:
                n_subjective_consistent += 1
            # 校准一致(校准后必然一致,除非 IC=0)
            if calibrated_dir == "higher-is-better" and rank_ic > 0:
                n_calibrated_consistent += 1
            elif calibrated_dir == "lower-is-better" and rank_ic < 0:
                n_calibrated_consistent += 1
        sub_rate = n_subjective_consistent / n_total if n_total > 0 else 0
        cal_rate = n_calibrated_consistent / n_total if n_total > 0 else 0
        lines.append(
            f"| {spec.style_name} | {n_total} | {n_subjective_consistent} | "
            f"{n_calibrated_consistent} | {_fmt_pct(sub_rate)} | "
            f"{_fmt_pct(cal_rate)} | {n_changed} |"
        )
    lines.append("")

    # 四、改进建议
    lines.append("## 四、改进建议")
    lines.append("")
    lines.append("### 4.1 短期(P0)")
    lines.append("")
    lines.append("1. **方向不一致的风格需要重新校准**: 若某风格的方向一致率 < 60%,")
    lines.append("   说明风格主观方向与市场实际方向不匹配,应改用数据驱动方向")
    lines.append("2. **多空价差为负的风格需要反思核心理念**: 复合评分单调性为负,")
    lines.append("   说明风格选股逻辑与市场反向")
    lines.append("")
    lines.append("### 4.2 中期(P1)")
    lines.append("")
    lines.append("3. **补充 dividend_yield 等基本面数据源**: 当前 dividend_yield 缺失,")
    lines.append("   价值投资风格的覆盖度有限")
    lines.append("4. **加入 ROE/营收增速等成长因子**: 当前用 60 日动量代理成长性,")
    lines.append("   不足以区分业绩驱动 vs 估值抬升")
    lines.append("5. **分阶段评估**: A 股 5 年可能经历风格切换,建议按年切片评估")
    lines.append("")
    lines.append("### 4.3 长期(P2)")
    lines.append("")
    lines.append("6. **机器学习权重**: 用 Lasso/Ridge 代替 |ICIR| 加权,自动处理因子相关性")
    lines.append("7. **加入中性化处理**: 对市值/行业中性化后再评估")
    lines.append("8. **多周期评估**: 短线打板 horizon=1d 失效,可退化到 3d/5d 重测")
    lines.append("")

    # 五、附录
    lines.append("## 五、附录")
    lines.append("")
    lines.append("### 5.1 风格因子清单")
    lines.append("")
    for style_id in list_style_ids():
        r = style_results[style_id]
        spec = r.style_spec
        lines.append(f"**{spec.style_name}** ({spec.style_id}):")
        lines.append("")
        lines.append(", ".join(spec.factor_ids))
        lines.append("")

    lines.append("### 5.2 新增风格专属因子(8 个)")
    lines.append("")
    for f in STYLE_SPECIFIC_FACTORS:
        d = f.definition()
        lines.append(f"- `{d.id}` ({d.name}): {d.description} | 方向: {d.direction} | "
                     f"warmup: {d.warmup_days}d | tags: {d.tags}")
    lines.append("")

    lines.append("---")
    lines.append("")
    lines.append(f"**报告生成**: 2026-07-26 (北京时间)")
    lines.append(f"**评估脚本**: scripts/run_style_comparison.py")
    lines.append(f"**因子总数**: 27 现有 + 8 新增 = 35 个")
    lines.append("")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text("\n".join(lines), encoding="utf-8")
    print(f"报告已保存: {output_path}")


# ========== Step 5: 主流程 ==========


def main() -> int:
    load_dotenv(EXPLORATION_ROOT / ".env")

    parser = argparse.ArgumentParser(description="多风格选股评分对比评估")
    parser.add_argument("--snapshot-root", default=os.environ.get("SNAPSHOT_ROOT", ""))
    parser.add_argument("--snapshot-id", default=os.environ.get("SNAPSHOT_ID", ""))
    parser.add_argument("--start", default=None)
    parser.add_argument("--end", default=None)
    parser.add_argument("--layers", type=int, default=None)
    parser.add_argument("--min-amount", type=float, default=None)
    parser.add_argument("--min-samples", type=int, default=None)
    parser.add_argument("--min-icir", type=float, default=2.0,
                        help="剔除 |rank_ic_ir| < min_icir 的弱因子(默认 2.0,0 表示不剔除)")
    parser.add_argument("--output", default=None,
                        help="报告输出路径(默认 tmp_output/STYLE_COMPARISON_REPORT_V2.md)")
    args = parser.parse_args()

    cfg = load_config()
    eval_cfg = cfg.get("evaluation", {}) or {}
    output_cfg = cfg.get("output", {}) or {}
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

    print("=== 多风格选股评分对比评估 (V2: auto_calibrate + min_icir) ===")
    print(f"快照根: {snapshot_root}")
    print(f"日期范围: {start} ~ {end}")
    print(f"分层数: {layers}, 最小样本: {min_samples}")
    print(f"min_icir: {args.min_icir} (剔除 |rank_ic_ir| < {args.min_icir} 的弱因子)")
    print(f"风格数: {len(STYLE_DEFINITIONS)} ({', '.join(list_style_ids())})")
    print()

    # 1. 收集所有需要的因子 ID
    existing_factor_ids = list_all_factor_ids()  # 27 个(包含 dividend_yield,会失败但被忽略)
    style_factor_ids = list_style_factor_ids()  # 8 个新增
    all_factor_ids = existing_factor_ids + style_factor_ids
    print(f"现有因子: {len(existing_factor_ids)} 个, 风格专属: {len(style_factor_ids)} 个, "
          f"合计: {len(all_factor_ids)} 个")
    print()

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

        # 3. 构造所有因子面板
        print("构造现有 27 个因子面板...")
        existing_panels = build_existing_factor_panels(candles, factor_ids=existing_factor_ids)
        n_valid_existing = sum(1 for p in existing_panels.values() if not p.empty)
        print(f"完成, 有效面板: {n_valid_existing}/{len(existing_factor_ids)}")

        print("构造 8 个新增风格专属因子面板...")
        style_panels = build_style_factor_panels(candles)
        n_valid_style = sum(1 for p in style_panels.values() if not p.empty)
        print(f"完成, 有效面板: {n_valid_style}/{len(style_factor_ids)}")

        # 合并面板
        all_panels = {**existing_panels, **style_panels}
        print(f"合并后面板数: {len(all_panels)}")
        print()

        # 4. 对每种风格运行评估
        style_results = {}
        for style_id in list_style_ids():
            spec = STYLE_DEFINITIONS[style_id]
            print(f"评估风格: {spec.style_name} ({style_id})")
            print(f"  因子数: {len(spec.factor_ids)}, 持有期: {spec.target_horizon}d, "
                  f"auto_calibrate: {spec.auto_calibrate}")
            scorer = StyleScorer(spec)
            result = scorer.evaluate(
                all_factor_panels=all_panels,
                candles_long=candles,
                layers=layers,
                min_samples=min_samples,
                min_icir=args.min_icir,
            )
            style_results[style_id] = result

            # 打印关键指标
            cr = result.composite_report
            spread = cr.long_short_spread
            mono = cr.monotonicity
            print(f"  多空价差: {_fmt_pct(spread)}, 单调性: {_fmt_float(mono)}")
            n_selected = len(result.selected_factor_ids)
            n_dropped = len(result.dropped_factors)
            n_changed = sum(
                1 for fid in spec.directions
                if result.calibrated_directions.get(fid) != spec.directions.get(fid)
                and spec.directions.get(fid) != "research"
            )
            print(f"  保留: {n_selected}, 剔除: {n_dropped}, 方向反转: {n_changed}")
            print()

    # 5. 生成报告
    if args.output:
        output_path = Path(args.output)
    else:
        # 默认输出到 量化回测/tmp_output (V2 版本)
        output_path = Path("d:/github_public_repo/量化回测/tmp_output/STYLE_COMPARISON_REPORT_V2.md")

    build_report(
        style_results=style_results,
        candles_count=len(candles),
        stock_count=stock_count,
        date_range=(start, end),
        snapshot_id=active_snapshot_id,
        output_path=output_path,
        min_icir=args.min_icir,
    )

    # 6. 同时保存详细数据 JSON(便于后续分析)
    import json
    data_path = output_path.parent / f"{output_path.stem}_data.json"
    data = {
        "_meta": {
            "min_icir": args.min_icir,
            "date_range": [start, end],
            "snapshot_id": active_snapshot_id,
        },
    }
    for style_id, r in style_results.items():
        spec = r.style_spec
        cr = r.composite_report
        data[style_id] = {
            "style_name": spec.style_name,
            "risk_level": spec.risk_level,
            "target_horizon": spec.target_horizon,
            "auto_calibrate": spec.auto_calibrate,
            "factor_ids": list(spec.factor_ids),
            "subjective_directions": spec.directions,
            "calibrated_directions": r.calibrated_directions,
            "selected_factor_ids": r.selected_factor_ids,
            "dropped_factors": r.dropped_factors,
            "weights": r.weights,
            "composite": {
                "long_short_spread": cr.long_short_spread,
                "monotonicity": cr.monotonicity,
                "layers": [
                    {"layer": m.layer, "sample_count": m.sample_count,
                     "average_return": m.average_return}
                    for m in cr.layers
                ],
            },
            "factor_reports": {
                fid: {
                    "subjective_direction": spec.directions.get(fid, "research"),
                    "calibrated_direction": r.calibrated_directions.get(fid, "research"),
                    "avg_rank_ic": rep.ic_summary.average_rank_ic,
                    "rank_ic_ir": rep.ic_summary.rank_ic_ir,
                    "rank_ic_positive_rate": rep.ic_summary.rank_ic_positive_rate,
                    "long_short_spread": rep.layered_report.long_short_spread,
                    "monotonicity": rep.layered_report.monotonicity,
                }
                for fid, rep in r.factor_reports.items()
            },
        }
    data_path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"详细数据已保存: {data_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
