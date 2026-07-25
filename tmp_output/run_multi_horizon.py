"""多周期因子评估脚本。

对同一份 K 线, 在 horizon=1/5/10/20 四个持有期下分别:
1. 构造对应周期的收益面板
2. 对所有因子计算 IC / Rank IC / ICIR / 分层收益 / 多空价差 / 单调性
3. 同时构造复合评分并评估

输出对比表, 观察因子在不同持有期的有效性衰减。
"""
from __future__ import annotations

import argparse
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import yaml
from dotenv import load_dotenv

PROJECT_ROOT = Path(r"D:\github_public_repo\评分规则探索")
sys.path.insert(0, str(PROJECT_ROOT))

from src.data import load_candles, open_duckdb_session  # noqa: E402
from src.evaluation.ic import (  # noqa: E402
    ICSummary,
    compute_daily_ic,
    summarize_ic,
)
from src.evaluation.layered import (  # noqa: E402
    LayerMetrics,
    LayeredReport,
    compute_layered_returns,
)
from src.evaluation.runner import FactorEvaluationReport  # noqa: E402
from src.factors.registry import DEFAULT_REGISTRY, list_all_factor_ids  # noqa: E402
from src.panel.vectorized import (  # noqa: E402
    build_all_factor_panels_vectorized as build_all_factor_panels,
)
from src.panel.returns import build_return_panel  # noqa: E402
from src.scoring import CompositeScorer  # noqa: E402


def load_config() -> dict:
    load_dotenv(PROJECT_ROOT / ".env")
    config_path = PROJECT_ROOT / "config.yaml"
    if not config_path.exists():
        return {}
    with open(config_path, "r", encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def _make_empty_ic() -> ICSummary:
    return ICSummary(
        sample_count=0, trading_days=0,
        average_ic=None, average_rank_ic=None,
        ic_ir=None, rank_ic_ir=None,
        ic_positive_rate=None, rank_ic_positive_rate=None,
    )


def _make_empty_layered(layers: int) -> LayeredReport:
    return LayeredReport(
        layers=[LayerMetrics(layer=j + 1, sample_count=0, average_return=None)
                for j in range(layers)],
        long_short_spread=None, monotonicity=None,
    )


def evaluate_one_horizon(
    factor_panels,
    return_panel,
    factor_ids: list[str],
    layers: int,
    min_samples: int,
    weight_source: str,
    normalize: str,
) -> tuple[dict, dict, LayeredReport]:
    """对单个 horizon 完成完整评估, 返回 (reports, weights, composite_report)。"""
    reports: dict[str, FactorEvaluationReport] = {}
    for fid in factor_ids:
        factor = DEFAULT_REGISTRY.get(fid)
        defn = factor.definition()
        fp = factor_panels.get(fid, None)
        if fp is None or fp.empty:
            reports[fid] = FactorEvaluationReport(
                factor_id=defn.id, factor_name=defn.name, direction=defn.direction,
                sample_count=0, trading_days=0,
                ic_summary=_make_empty_ic(),
                layered_report=_make_empty_layered(layers),
                evaluated_at=datetime.now(timezone.utc).isoformat(),
            )
            continue
        daily_metrics = compute_daily_ic(fp, return_panel, min_samples)
        ic_summary = summarize_ic(daily_metrics)
        layered = compute_layered_returns(fp, return_panel, layers, min_samples)
        reports[fid] = FactorEvaluationReport(
            factor_id=defn.id, factor_name=defn.name, direction=defn.direction,
            sample_count=ic_summary.sample_count, trading_days=ic_summary.trading_days,
            ic_summary=ic_summary, layered_report=layered,
            evaluated_at=datetime.now(timezone.utc).isoformat(),
        )

    # 提取权重
    weights: dict[str, float] = {}
    for fid, r in reports.items():
        wv = (r.ic_summary.rank_ic_ir if weight_source == "rank_ic_ir"
              else r.ic_summary.ic_ir)
        if wv is not None:
            weights[fid] = abs(wv)

    # 复合评分
    directions = {fid: r.direction for fid, r in reports.items()}
    scorer = CompositeScorer(factor_directions=directions)
    scorer.fit(weights)
    if weights:
        composite_panel = scorer.score(factor_panels, normalize=normalize)
        composite_report = scorer.evaluate(
            composite_panel, return_panel, layers=layers, min_samples=min_samples,
        )
    else:
        composite_report = _make_empty_layered(layers)
    return reports, weights, composite_report


def fmt_pct(x) -> str:
    if x is None:
        return "N/A"
    return f"{x:.4%}"


def fmt_num(x, prec: int = 4) -> str:
    if x is None:
        return "N/A"
    return f"{x:.{prec}f}"


def main() -> int:
    load_dotenv(PROJECT_ROOT / ".env")

    parser = argparse.ArgumentParser(description="多周期因子评估")
    parser.add_argument("--snapshot-root", default=os.environ.get("SNAPSHOT_ROOT", ""))
    parser.add_argument("--snapshot-id", default=os.environ.get("SNAPSHOT_ID", ""))
    parser.add_argument("--start", default=None)
    parser.add_argument("--end", default=None)
    parser.add_argument("--horizons", type=int, nargs="+", default=[1, 5, 10, 20])
    parser.add_argument("--layers", type=int, default=None)
    parser.add_argument("--min-amount", type=float, default=None)
    parser.add_argument("--normalize", choices=["zscore", "rank"], default=None)
    parser.add_argument("--weight-source", choices=["rank_ic_ir", "ic_ir"], default=None)
    parser.add_argument("--output-dir", default=None)
    parser.add_argument("--factor-ids", nargs="*", default=None)
    args = parser.parse_args()

    cfg = load_config()
    eval_cfg = cfg.get("evaluation", {}) or {}
    scoring_cfg = cfg.get("scoring", {}) or {}
    output_cfg = cfg.get("output", {}) or {}
    duckdb_cfg = cfg.get("duckdb", {}) or {}

    snapshot_root = args.snapshot_root or eval_cfg.get("snapshot_root")
    if not snapshot_root:
        print("错误: 未指定 --snapshot-root", file=sys.stderr)
        return 1

    start = args.start or eval_cfg.get("default_start_date", "2021-07-25")
    end = args.end or eval_cfg.get("default_end_date", "2026-07-24")
    horizons = args.horizons
    layers = args.layers or int(eval_cfg.get("default_layers", 5))
    min_amount = args.min_amount if args.min_amount is not None else float(
        eval_cfg.get("default_min_daily_amount", 10_000_000)
    )
    min_samples = int(eval_cfg.get("default_min_samples", 30))
    factor_ids = args.factor_ids or list_all_factor_ids()
    output_dir = Path(args.output_dir or output_cfg.get("reports_dir", "./output"))
    output_dir.mkdir(parents=True, exist_ok=True)
    normalize = args.normalize or scoring_cfg.get("normalize", "zscore")
    weight_source = args.weight_source or scoring_cfg.get("weight_source", "rank_ic_ir")
    threads = int(duckdb_cfg.get("threads", 4))
    max_memory = duckdb_cfg.get("max_memory", "2GB")

    print("=== 多周期因子评估 ===")
    print(f"快照根: {snapshot_root}")
    print(f"日期范围: {start} ~ {end}")
    print(f"horizons: {horizons}")
    print(f"layers={layers}, normalize={normalize}, weight_source={weight_source}")
    print(f"因子数: {len(factor_ids)}")
    print()

    snapshot_id = args.snapshot_id or None
    with open_duckdb_session(snapshot_root, snapshot_id=snapshot_id,
                              threads=threads, max_memory=max_memory) as session:
        print(f"当前快照: {session.snapshot.snapshot_id}")
        candles = load_candles(session, start_date=start, end_date=end,
                                min_daily_amount=min_amount)
        print(f"加载 {len(candles)} 条 K 线, "
              f"{candles['instrumentKey'].nunique()} 只股票")
        print()

        # 因子面板只需构造一次(与 horizon 无关)
        print(f"构造 {len(factor_ids)} 个因子面板(一次性)...")
        factor_panels = build_all_factor_panels(candles, factor_ids=factor_ids)
        print("完成")
        print()

        # 对每个 horizon 单独评估
        all_results: dict[int, tuple[dict, dict, LayeredReport]] = {}
        for h in horizons:
            print(f"--- 评估 horizon={h}d ---")
            print(f"构造 horizon={h} 收益面板...")
            return_panel = build_return_panel(candles, horizon=h)
            print(f"  收益面板 shape={return_panel.shape}")
            reports, weights, composite_report = evaluate_one_horizon(
                factor_panels, return_panel, factor_ids,
                layers=layers, min_samples=min_samples,
                weight_source=weight_source, normalize=normalize,
            )
            all_results[h] = (reports, weights, composite_report)
            spread = composite_report.long_short_spread
            mono = composite_report.monotonicity
            print(f"  复合评分多空价差={fmt_pct(spread)}, 单调性={fmt_num(mono)}")
            print()

        # ============ 生成报告 ============
        sections: list[str] = []
        sections.append("# 多周期因子评估报告")
        sections.append("")
        sections.append(f"- 生成时间: {datetime.now().isoformat()}")
        sections.append(f"- 日期范围: {start} ~ {end} (5 年)")
        sections.append(f"- horizons: {horizons}")
        sections.append(f"- 标准化: {normalize}, 权重源: {weight_source}")
        sections.append(f"- 因子数: {len(factor_ids)}")
        sections.append("")

        # 1. 复合评分对比总表
        sections.append("## 一、复合评分多周期对比")
        sections.append("")
        sections.append("| horizon | 多空价差 | 单调性 | 层1收益 | 层2收益 | 层3收益 | 层4收益 | 层5收益 |")
        sections.append("|---|---|---|---|---|---|---|---|")
        for h in horizons:
            _, _, cr = all_results[h]
            spread = cr.long_short_spread
            mono = cr.monotonicity
            layer_returns = [m.average_return for m in cr.layers]
            row = f"| {h}d | {fmt_pct(spread)} | {fmt_num(mono)} |"
            for lr in layer_returns:
                row += f" {fmt_pct(lr)} |"
            sections.append(row)
        sections.append("")
        sections.append("### 解读")
        sections.append("- **多空价差**: 层5 - 层1 平均收益, 越大越好")
        sections.append("- **单调性**: 各层收益与层序号相关系数, +1 为完美单调递增")
        sections.append("- **观察重点**: 哪个 horizon 复合评分最有效, ICIR 衰减有多快")
        sections.append("")

        # 2. 单因子 IC 衰减表(按 horizon=5 的 |rank_ic_ir| 排序)
        ref_h = 5 if 5 in horizons else horizons[0]
        sections.append(f"## 二、单因子 IC 衰减表(按 horizon={ref_h}d 的 |rank_ic_ir| 降序)")
        sections.append("")
        header = "| factor_id | factor_name | direction |"
        sep = "|---|---|---|"
        for h in horizons:
            header += f" IC@{h}d | RankIC@{h}d | ICIR@{h}d | L-S@{h}d |"
            sep += "---|---|---|---|"
        sections.append(header)
        sections.append(sep)

        ref_reports = all_results[ref_h][0]
        sorted_fids = sorted(
            factor_ids,
            key=lambda fid: -abs(ref_reports[fid].ic_summary.rank_ic_ir or 0),
        )
        for fid in sorted_fids:
            r0 = ref_reports[fid]
            row = f"| {fid} | {r0.factor_name} | {r0.direction} |"
            for h in horizons:
                r = all_results[h][0][fid]
                ic = r.ic_summary.average_ic
                ric = r.ic_summary.average_rank_ic
                ir = r.ic_summary.rank_ic_ir
                ls = r.layered_report.long_short_spread
                row += (f" {fmt_num(ic, 4)} | {fmt_num(ric, 4)} | "
                        f"{fmt_num(ir, 2)} | {fmt_pct(ls)} |")
            sections.append(row)
        sections.append("")

        # 3. 权重对比
        sections.append(f"## 三、各周期权重对比(Top 10, 按 horizon={ref_h}d 排序)")
        sections.append("")
        header = "| factor_id |"
        sep = "|---|"
        for h in horizons:
            header += f" w@{h}d |"
            sep += "---|"
        sections.append(header)
        sections.append(sep)
        w_ref = all_results[ref_h][1]
        top10 = sorted(w_ref.items(), key=lambda kv: -kv[1])[:10]
        for fid, _ in top10:
            row = f"| {fid} |"
            for h in horizons:
                w = all_results[h][1].get(fid, 0.0)
                row += f" {w:.4f} |"
            sections.append(row)
        sections.append("")

        # 4. IC 衰减关键发现
        sections.append("## 四、IC 衰减关键发现")
        sections.append("")
        if 1 in horizons and 20 in horizons:
            sections.append("### ICIR 衰减比 (ICIR@20d / ICIR@1d)")
            sections.append("")
            sections.append("| factor_id | ICIR@1d | ICIR@5d | ICIR@10d | ICIR@20d | 衰减比 |")
            sections.append("|---|---|---|---|---|---|")
            decay_list = []
            for fid in factor_ids:
                ir1 = all_results[1][0][fid].ic_summary.rank_ic_ir
                ir5 = all_results[5][0][fid].ic_summary.rank_ic_ir if 5 in horizons else None
                ir10 = all_results[10][0][fid].ic_summary.rank_ic_ir if 10 in horizons else None
                ir20 = all_results[20][0][fid].ic_summary.rank_ic_ir
                if ir1 and ir20 and abs(ir1) > 0.1:
                    decay = ir20 / ir1
                    decay_list.append((fid, ir1, ir5, ir10, ir20, decay))
            decay_list.sort(key=lambda x: -abs(x[5]))
            for fid, ir1, ir5, ir10, ir20, decay in decay_list[:15]:
                row = (f"| {fid} | {fmt_num(ir1, 2)} | {fmt_num(ir5, 2)} | "
                       f"{fmt_num(ir10, 2)} | {fmt_num(ir20, 2)} | {decay:.2f} |")
                sections.append(row)
            sections.append("")
            sections.append("- **衰减比 > 1**: 长期因子(20d 比 1d 更有效)")
            sections.append("- **衰减比 < 1**: 短期因子(快速衰减)")
            sections.append("- **负数**: 因子方向在不同周期下反转")
            sections.append("")
        else:
            sections.append("需要同时包含 horizon=1 和 20 才能计算衰减比")
            sections.append("")

        # 5. 复合评分各 horizon 分层细节
        sections.append("## 五、各 horizon 复合评分分层细节")
        sections.append("")
        for h in horizons:
            _, _, cr = all_results[h]
            sections.append(f"### horizon={h}d")
            sections.append("")
            sections.append("| 层级 | 样本数 | 平均收益 |")
            sections.append("|---|---|---|")
            for m in cr.layers:
                sections.append(f"| {m.layer} | {m.sample_count} | {fmt_pct(m.average_return)} |")
            sections.append("")
            sections.append(f"- 多空价差: {fmt_pct(cr.long_short_spread)}")
            sections.append(f"- 单调性: {fmt_num(cr.monotonicity)}")
            sections.append("")

        # 6. 推荐持有期
        sections.append("## 六、推荐持有期分析")
        sections.append("")
        best_h = None
        best_spread = -1
        for h in horizons:
            cr = all_results[h][2]
            sp = cr.long_short_spread or 0
            if sp > best_spread:
                best_spread = sp
                best_h = h
        sections.append(f"基于多空价差, **最优 horizon = {best_h}d**, 多空价差 = {fmt_pct(best_spread)}")
        sections.append("")
        sections.append("### 年化估算 (未扣交易成本)")
        sections.append("")
        sections.append("| horizon | 单次多空价差 | 假设年化换手 | 年化收益(毛) |")
        sections.append("|---|---|---|---|")
        for h in horizons:
            cr = all_results[h][2]
            sp = cr.long_short_spread
            if sp is None:
                continue
            annual_turnover = 252 // h
            annual_ret = sp * annual_turnover
            sections.append(f"| {h}d | {fmt_pct(sp)} | {annual_turnover}x | {fmt_pct(annual_ret)} |")
        sections.append("")
        sections.append("**注**: 实际需扣除双边交易成本(佣金+滑点+印花税约 0.2%/次)。")
        sections.append("")

        # 7. 风险提示
        sections.append("## 七、风险提示")
        sections.append("")
        sections.append("1. **多周期评估未做中性化**: 规模/行业因子可能在不同 horizon 下干扰不同")
        sections.append("2. **未扣交易成本**: horizon=1d 换手 252x/年, 交易成本占大头")
        sections.append("3. **5 年整体可能掩盖风格切换**: 短期 horizon 对风格更敏感")
        sections.append("4. **horizon=20d 样本数较少**: 末尾 20 天无法计算 forward return")
        sections.append("")

        report_path = output_dir / f"multi_horizon_eval_{datetime.now().strftime('%Y%m%d_%H%M%S')}.md"
        report_path.write_text("\n".join(sections), encoding="utf-8")
        print(f"报告已保存: {report_path}")

        # 同时复制到 量化回测/tmp_output
        import shutil
        target = Path(r"D:/github_public_repo/量化回测/tmp_output") / report_path.name
        try:
            shutil.copy(report_path, target)
            print(f"已复制到: {target}")
        except Exception as e:
            print(f"复制失败: {e}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
