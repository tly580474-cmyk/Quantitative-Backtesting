"""5 种投资风格定义的单元测试。"""

from __future__ import annotations

import pytest

from src.factors.base import FactorDirection
from src.styles.definitions import (
    STYLE_DEFINITIONS,
    CONTRARIAN_SPEC,
    GROWTH_SPEC,
    SHORT_TERM_SPEC,
    TREND_SPEC,
    VALUE_SPEC,
    get_style_spec,
    list_style_ids,
)


class TestStyleDefinitions:
    def test_style_count(self):
        assert len(STYLE_DEFINITIONS) == 5

    def test_style_ids(self):
        ids = list_style_ids()
        assert set(ids) == {"contrarian", "value", "growth", "trend", "short_term"}

    @pytest.mark.parametrize("spec", [
        CONTRARIAN_SPEC, VALUE_SPEC, GROWTH_SPEC, TREND_SPEC, SHORT_TERM_SPEC,
    ])
    def test_spec_fields(self, spec):
        assert spec.style_id
        assert spec.style_name
        assert spec.risk_level
        assert spec.target_horizon >= 1
        assert spec.weight_horizon >= 1
        assert len(spec.factor_ids) > 0
        assert isinstance(spec.directions, dict)
        assert spec.description

    @pytest.mark.parametrize("spec", [
        CONTRARIAN_SPEC, VALUE_SPEC, GROWTH_SPEC, TREND_SPEC, SHORT_TERM_SPEC,
    ])
    def test_directions_cover_all_factors(self, spec):
        """风格的 directions 字典必须覆盖所有 factor_ids。"""
        for fid in spec.factor_ids:
            assert fid in spec.directions, (
                f"风格 {spec.style_id} 的 directions 未覆盖因子 {fid}"
            )
            d = spec.directions[fid]
            assert d in (
                FactorDirection.HIGHER_IS_BETTER,
                FactorDirection.LOWER_IS_BETTER,
                FactorDirection.RESEARCH,
            ), f"风格 {spec.style_id} 的因子 {fid} 方向无效: {d}"

    @pytest.mark.parametrize("spec", [
        CONTRARIAN_SPEC, VALUE_SPEC, GROWTH_SPEC, TREND_SPEC, SHORT_TERM_SPEC,
    ])
    def test_spec_immutable(self, spec):
        """StyleSpec 必须不可变(frozen=True)。"""
        with pytest.raises(Exception):
            spec.style_id = "modified"  # type: ignore

    def test_get_style_spec(self):
        spec = get_style_spec("value")
        assert spec.style_id == "value"
        assert spec.style_name == "价值投资"

    def test_get_style_spec_unknown(self):
        with pytest.raises(KeyError):
            get_style_spec("unknown_style")


class TestStyleFactorSets:
    """验证各风格的因子集合合理性。"""

    def test_contrarian_uses_existing_26(self):
        """逆向抄底应使用现有 26 个因子(不含 dividend_yield)。"""
        assert "dividend_yield" not in CONTRARIAN_SPEC.factor_ids
        assert len(CONTRARIAN_SPEC.factor_ids) == 26

    def test_value_uses_valuation_factors(self):
        assert "pe_ttm" in VALUE_SPEC.factor_ids
        assert "pb" in VALUE_SPEC.factor_ids
        assert "ps_ttm" in VALUE_SPEC.factor_ids

    def test_growth_includes_momentum_60d(self):
        assert "momentum_60d" in GROWTH_SPEC.factor_ids

    def test_trend_includes_new_factors(self):
        assert "atr_20" in TREND_SPEC.factor_ids
        assert "turtle_breakout_20" in TREND_SPEC.factor_ids
        assert "ma_alignment_strength" in TREND_SPEC.factor_ids

    def test_short_term_includes_new_factors(self):
        assert "limit_up_consecutive" in SHORT_TERM_SPEC.factor_ids
        assert "kdj_j" in SHORT_TERM_SPEC.factor_ids
        assert "bias_6" in SHORT_TERM_SPEC.factor_ids
        assert "intraday_strength" in SHORT_TERM_SPEC.factor_ids


class TestStyleDirections:
    """验证各风格的方向标注符合风格理念。"""

    def test_value_directions(self):
        """价值投资: 低估值、大盘、低换手、低回撤。"""
        d = VALUE_SPEC.directions
        assert d["pe_ttm"] == FactorDirection.LOWER_IS_BETTER
        assert d["pb"] == FactorDirection.LOWER_IS_BETTER
        assert d["log_market_cap"] == FactorDirection.HIGHER_IS_BETTER
        assert d["turnover_rate"] == FactorDirection.LOWER_IS_BETTER
        assert d["drawdown_20d"] == FactorDirection.LOWER_IS_BETTER

    def test_growth_directions_all_higher(self):
        """成长型: 高动量、高估值、放量上涨(全部 higher)。"""
        for fid, d in GROWTH_SPEC.directions.items():
            assert d == FactorDirection.HIGHER_IS_BETTER, (
                f"成长型因子 {fid} 应为 higher, 实际 {d}"
            )

    def test_trend_directions_all_higher(self):
        """趋势型: 趋势延续(全部 higher)。"""
        for fid, d in TREND_SPEC.directions.items():
            assert d == FactorDirection.HIGHER_IS_BETTER

    def test_short_term_directions_all_higher(self):
        """短线打板: 强势延续(全部 higher)。"""
        for fid, d in SHORT_TERM_SPEC.directions.items():
            assert d == FactorDirection.HIGHER_IS_BETTER


class TestStyleHorizons:
    """验证各风格的目标 horizon 合理。"""

    def test_contrarian_horizon_5(self):
        assert CONTRARIAN_SPEC.target_horizon == 5
        assert CONTRARIAN_SPEC.weight_horizon == 5

    def test_value_horizon_20(self):
        assert VALUE_SPEC.target_horizon == 20

    def test_growth_horizon_20(self):
        assert GROWTH_SPEC.target_horizon == 20

    def test_trend_horizon_20(self):
        assert TREND_SPEC.target_horizon == 20

    def test_short_term_horizon_1(self):
        # 短线打板默认 1d, 失效时退化到 3d
        assert SHORT_TERM_SPEC.target_horizon == 1


class TestAutoCalibrate:
    """验证 auto_calibrate 字段配置正确。"""

    def test_contrarian_no_calibrate(self):
        """逆向抄底: 基线风格,主观方向已被数据驱动校准过,不需再校准。"""
        assert CONTRARIAN_SPEC.auto_calibrate is False

    def test_value_calibrate_enabled(self):
        """价值投资: 单因子方向主观正确,但复合后失效,启用校准纠正复合偏差。"""
        assert VALUE_SPEC.auto_calibrate is True

    def test_growth_calibrate_enabled(self):
        """成长型: A 股反转效应使主观方向与 IC 反向,需启用校准。"""
        assert GROWTH_SPEC.auto_calibrate is True

    def test_trend_calibrate_enabled(self):
        """趋势型: 同成长型,需启用校准。"""
        assert TREND_SPEC.auto_calibrate is True

    def test_short_term_calibrate_enabled(self):
        """短线打板: horizon=1d 复合统计弱,启用校准提升稳定性。"""
        assert SHORT_TERM_SPEC.auto_calibrate is True

    def test_default_no_calibrate(self):
        """StyleSpec 默认 auto_calibrate=False, 保持向后兼容。"""
        from src.styles.definitions import StyleSpec

        spec = StyleSpec(
            style_id="test",
            style_name="test",
            risk_level="test",
            target_horizon=5,
            weight_horizon=5,
            factor_ids=("f1",),
            directions={"f1": FactorDirection.HIGHER_IS_BETTER},
        )
        assert spec.auto_calibrate is False
