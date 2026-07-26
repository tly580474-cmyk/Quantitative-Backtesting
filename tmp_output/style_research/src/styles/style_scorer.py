"""风格评分器:基于风格规格构建复合评分并评估。

复用现有 CompositeScorer / compute_daily_ic / compute_layered_returns,
核心差异在于:
1. 使用风格特定的因子子集(StyleSpec.factor_ids)
2. 使用风格特定的方向覆盖(StyleSpec.directions)
3. 在风格特定的 horizon 下计算 ICIR 权重
4. 在风格特定的 horizon 下评估分层收益

P0 增强:
- auto_calibrate=True 时,按 avg_rank_ic 符号自动决定方向(覆盖主观 directions)
- min_icir > 0 时,剔除 |rank_ic_ir| < min_icir 的弱因子
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone

import pandas as pd

from src.evaluation.ic import (
    ICSummary,
    compute_daily_ic,
    summarize_ic,
)
from src.evaluation.layered import LayeredReport, compute_layered_returns
from src.evaluation.runner import FactorEvaluationReport
from src.factors.base import FactorDirection
from src.panel.returns import build_return_panel
from src.scoring import CompositeScorer
from src.styles.definitions import StyleSpec


@dataclass
class StyleEvaluationResult:
    """单风格评估结果。"""

    style_spec: StyleSpec
    factor_reports: dict[str, FactorEvaluationReport]
    weights: dict[str, float]
    composite_report: LayeredReport
    calibrated_directions: dict[str, str]
    """最终用于评分的方向(可能经 auto_calibrate 覆盖)"""
    selected_factor_ids: list[str]
    """通过 min_icir 过滤后保留的因子 ID 列表"""
    dropped_factors: dict[str, str]
    """被剔除的因子及原因 (factor_id -> reason)"""
    evaluated_at: str


class StyleScorer:
    """风格评分器。

    用法:
        scorer = StyleScorer(spec)
        result = scorer.evaluate(
            all_factor_panels=panels,
            candles_long=candles,
            layers=5,
            min_samples=30,
            min_icir=2.0,  # P0: 剔除 |rank_ic_ir| < 2.0 的弱因子
        )
    """

    def __init__(self, spec: StyleSpec) -> None:
        self.spec = spec

    def evaluate(
        self,
        all_factor_panels: dict[str, pd.DataFrame],
        candles_long: pd.DataFrame,
        layers: int = 5,
        min_samples: int = 30,
        min_icir: float = 0.0,
    ) -> StyleEvaluationResult:
        """对单风格完成完整评估。

        Args:
            all_factor_panels: 全部因子面板(含现有 27 + 新增 8)
            candles_long: K 线长表(用于构造收益面板)
            layers: 分层数
            min_samples: IC 计算最小样本
            min_icir: 剔除 |rank_ic_ir| < min_icir 的弱因子,0 表示不剔除

        Returns:
            StyleEvaluationResult
        """
        spec = self.spec

        # 1. 构造对应 horizon 的收益面板
        return_panel = build_return_panel(candles_long, horizon=spec.target_horizon)

        # 2. 对每个风格因子计算 IC/ICIR/分层(用 RESEARCH 方向,获取原始 IC)
        raw_reports: dict[str, FactorEvaluationReport] = {}
        for fid in spec.factor_ids:
            fp = all_factor_panels.get(fid)
            if fp is None or fp.empty:
                raw_reports[fid] = self._make_empty_report(fid, layers)
                continue

            daily_metrics = compute_daily_ic(fp, return_panel, min_samples)
            ic_summary = summarize_ic(daily_metrics)
            layered = compute_layered_returns(fp, return_panel, layers, min_samples)

            raw_reports[fid] = FactorEvaluationReport(
                factor_id=fid,
                factor_name=fid,
                direction=FactorDirection.RESEARCH,  # 先用 RESEARCH 拿原始 IC
                sample_count=ic_summary.sample_count,
                trading_days=ic_summary.trading_days,
                ic_summary=ic_summary,
                layered_report=layered,
                evaluated_at=datetime.now(timezone.utc).isoformat(),
            )

        # 3. P0-1: 方向校准(auto_calibrate 模式)
        calibrated_directions: dict[str, str] = dict(spec.directions)
        if spec.auto_calibrate:
            for fid, rep in raw_reports.items():
                avg_ric = rep.ic_summary.average_rank_ic
                if avg_ric is None or pd.isna(avg_ric):
                    # IC 缺失,保留主观方向
                    continue
                if avg_ric > 0:
                    calibrated_directions[fid] = FactorDirection.HIGHER_IS_BETTER
                else:
                    calibrated_directions[fid] = FactorDirection.LOWER_IS_BETTER

        # 4. P0-2: 弱因子剔除
        selected_factor_ids: list[str] = []
        dropped_factors: dict[str, str] = {}
        for fid in spec.factor_ids:
            rep = raw_reports.get(fid)
            if rep is None:
                dropped_factors[fid] = "missing_panel"
                continue
            if rep.sample_count == 0:
                dropped_factors[fid] = "empty_panel"
                continue
            ric_ir = rep.ic_summary.rank_ic_ir
            if ric_ir is None or pd.isna(ric_ir):
                dropped_factors[fid] = "ic_undefined"
                continue
            if min_icir > 0 and abs(ric_ir) < min_icir:
                dropped_factors[fid] = f"weak_icir={abs(ric_ir):.2f}<{min_icir}"
                continue
            selected_factor_ids.append(fid)

        # 5. 重新构造最终的 factor_reports(用校准后的方向)
        factor_reports: dict[str, FactorEvaluationReport] = {}
        for fid in selected_factor_ids:
            rep = raw_reports[fid]
            factor_reports[fid] = FactorEvaluationReport(
                factor_id=fid,
                factor_name=rep.factor_name,
                direction=calibrated_directions.get(fid, FactorDirection.RESEARCH),
                sample_count=rep.sample_count,
                trading_days=rep.trading_days,
                ic_summary=rep.ic_summary,
                layered_report=rep.layered_report,
                evaluated_at=rep.evaluated_at,
            )

        # 6. 提取权重(P2: 支持 icir / equal 两种模式)
        weights: dict[str, float] = {}
        if spec.weighting == "equal":
            # 等权: 所有选中因子权重为 1.0
            for fid in factor_reports:
                weights[fid] = 1.0
        else:
            # 默认 ICIR 加权: |rank_ic_ir|
            for fid, r in factor_reports.items():
                wv = r.ic_summary.rank_ic_ir
                if wv is not None and not pd.isna(wv):
                    weights[fid] = abs(wv)

        # 7. 退化处理:若剔除后因子数 < 3,放宽阈值,保留所有有 IC 的因子
        if len(selected_factor_ids) < 3:
            for fid in spec.factor_ids:
                if fid in selected_factor_ids:
                    continue
                rep = raw_reports.get(fid)
                if rep is None or rep.sample_count == 0:
                    continue
                ric_ir = rep.ic_summary.rank_ic_ir
                if ric_ir is None or pd.isna(ric_ir):
                    continue
                selected_factor_ids.append(fid)
                factor_reports[fid] = FactorEvaluationReport(
                    factor_id=fid,
                    factor_name=rep.factor_name,
                    direction=calibrated_directions.get(fid, FactorDirection.RESEARCH),
                    sample_count=rep.sample_count,
                    trading_days=rep.trading_days,
                    ic_summary=rep.ic_summary,
                    layered_report=rep.layered_report,
                    evaluated_at=rep.evaluated_at,
                )
                weights[fid] = abs(ric_ir)
                dropped_factors.pop(fid, None)

        # 8. 调用 CompositeScorer 构造复合评分
        if not weights:
            # 所有权重无效, 用等权退化
            n = len(selected_factor_ids) if selected_factor_ids else len(spec.factor_ids)
            if n == 0:
                weights = {fid: 1.0 for fid in spec.factor_ids}
                selected_factor_ids = list(spec.factor_ids)
            else:
                weights = {fid: 1.0 / n for fid in selected_factor_ids}

        scorer = CompositeScorer(factor_directions=calibrated_directions)
        scorer.fit(weights)

        # 用风格子集的因子面板构造复合评分
        style_factor_panels = {
            fid: all_factor_panels[fid]
            for fid in selected_factor_ids
            if fid in all_factor_panels and not all_factor_panels[fid].empty
        }

        if not style_factor_panels:
            composite_report = self._make_empty_layered(layers)
        else:
            composite_panel = scorer.score(style_factor_panels, normalize="zscore")
            composite_report = scorer.evaluate(
                composite_panel, return_panel,
                layers=layers, min_samples=min_samples,
            )

        return StyleEvaluationResult(
            style_spec=spec,
            factor_reports=factor_reports,
            weights=weights,
            composite_report=composite_report,
            calibrated_directions=calibrated_directions,
            selected_factor_ids=selected_factor_ids,
            dropped_factors=dropped_factors,
            evaluated_at=datetime.now(timezone.utc).isoformat(),
        )

    def _make_empty_report(self, factor_id: str, layers: int) -> FactorEvaluationReport:
        """构造空因子评估报告。"""
        from src.evaluation.layered import LayerMetrics

        empty_ic = ICSummary(
            sample_count=0, trading_days=0,
            average_ic=None, average_rank_ic=None,
            ic_ir=None, rank_ic_ir=None,
            ic_positive_rate=None, rank_ic_positive_rate=None,
        )
        empty_layered = LayeredReport(
            layers=[LayerMetrics(layer=j + 1, sample_count=0, average_return=None)
                    for j in range(layers)],
            long_short_spread=None, monotonicity=None,
        )
        return FactorEvaluationReport(
            factor_id=factor_id,
            factor_name=factor_id,
            direction=self.spec.directions.get(factor_id, "research"),
            sample_count=0, trading_days=0,
            ic_summary=empty_ic,
            layered_report=empty_layered,
            evaluated_at=datetime.now(timezone.utc).isoformat(),
        )

    def _make_empty_layered(self, layers: int) -> LayeredReport:
        """构造空分层报告。"""
        from src.evaluation.layered import LayerMetrics

        return LayeredReport(
            layers=[LayerMetrics(layer=j + 1, sample_count=0, average_return=None)
                    for j in range(layers)],
            long_short_spread=None, monotonicity=None,
        )


__all__ = ["StyleScorer", "StyleEvaluationResult"]
