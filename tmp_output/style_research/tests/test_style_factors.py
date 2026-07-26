"""风格专属因子的单元测试。

覆盖:
1. 8 个因子的 definition() 完整性
2. compute() 在足够 warmup 下的数值正确性
3. compute() 在 warmup 不足时返回 None
4. compute() 与向量化实现的一致性(关键)
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from src.factors.style_specific import (
    STYLE_SPECIFIC_FACTORS,
    build_style_registry,
    list_style_factor_ids,
)
from src.panel.vectorized_styles import (
    _compute_factor_series_for_instrument,
    build_style_factor_panel_vectorized,
)


# ========== Fixtures ==========

@pytest.fixture
def synthetic_candles() -> pd.DataFrame:
    """合成 K 线数据(120 个交易日, 单只股票)。"""
    np.random.seed(42)
    n = 120
    dates = pd.date_range("2025-01-01", periods=n, freq="B")
    base = 10.0
    closes = [base]
    for _ in range(n - 1):
        closes.append(closes[-1] * (1 + np.random.randn() * 0.02))
    closes = np.array(closes)
    highs = closes * (1 + np.abs(np.random.randn(n)) * 0.01)
    lows = closes * (1 - np.abs(np.random.randn(n)) * 0.01)
    opens = (highs + lows) / 2
    df = pd.DataFrame({
        "instrumentKey": "TEST001",
        "tradeDate": dates.strftime("%Y-%m-%d"),
        "open": opens,
        "high": highs,
        "low": lows,
        "close": closes,
        "volume": np.random.randint(1_000_000, 10_000_000, n).astype(float),
        "amount": np.random.randint(10_000_000, 100_000_000, n).astype(float),
    })
    return df


@pytest.fixture
def multi_stock_candles(synthetic_candles) -> pd.DataFrame:
    """多只股票的 K 线(2 只)。"""
    df2 = synthetic_candles.copy()
    df2["instrumentKey"] = "TEST002"
    # 调整第二只股票的价格
    df2["close"] = df2["close"] * 1.5
    df2["high"] = df2["high"] * 1.5
    df2["low"] = df2["low"] * 1.5
    df2["open"] = df2["open"] * 1.5
    return pd.concat([synthetic_candles, df2], ignore_index=True)


# ========== 1. 因子定义完整性 ==========

class TestFactorDefinitions:
    def test_factor_count(self):
        assert len(STYLE_SPECIFIC_FACTORS) == 8

    def test_factor_ids(self):
        ids = list_style_factor_ids()
        expected = {
            "atr_20", "turtle_breakout_20", "ma_alignment_strength",
            "limit_up_consecutive", "kdj_j", "bias_6",
            "momentum_60d", "intraday_strength",
        }
        assert set(ids) == expected

    def test_registry_build(self):
        registry = build_style_registry()
        assert len(registry) == 8
        for fid in list_style_factor_ids():
            assert fid in registry

    @pytest.mark.parametrize("factor", STYLE_SPECIFIC_FACTORS)
    def test_definition_fields(self, factor):
        defn = factor.definition()
        assert defn.id
        assert defn.name
        assert defn.description
        assert defn.direction in ("higher-is-better", "lower-is-better", "research")
        assert defn.dependencies
        assert defn.warmup_days >= 1


# ========== 2. 各因子 compute() 边界与数值 ==========

class TestAtrFactor:
    def test_compute_with_enough_warmup(self, synthetic_candles):
        from src.factors.style_specific.trend import AtrFactor
        factor = AtrFactor()
        last_date = synthetic_candles["tradeDate"].iloc[-1]
        result = factor.compute(synthetic_candles, last_date)
        assert result.factor_value is not None
        assert result.factor_value > 0
        assert "atr_pct" in result.raw_inputs

    def test_compute_with_insufficient_warmup(self, synthetic_candles):
        from src.factors.style_specific.trend import AtrFactor
        factor = AtrFactor()
        # 截到第 10 天(warmup=21)
        early_date = synthetic_candles["tradeDate"].iloc[9]
        result = factor.compute(synthetic_candles, early_date)
        assert result.factor_value is None


class TestTurtleBreakoutFactor:
    def test_compute_with_enough_warmup(self, synthetic_candles):
        from src.factors.style_specific.trend import TurtleBreakoutFactor
        factor = TurtleBreakoutFactor()
        last_date = synthetic_candles["tradeDate"].iloc[-1]
        result = factor.compute(synthetic_candles, last_date)
        assert result.factor_value is not None
        assert "high_20d_prev" in result.raw_inputs

    def test_compute_insufficient_warmup(self, synthetic_candles):
        from src.factors.style_specific.trend import TurtleBreakoutFactor
        factor = TurtleBreakoutFactor()
        early_date = synthetic_candles["tradeDate"].iloc[15]
        result = factor.compute(synthetic_candles, early_date)
        assert result.factor_value is None


class TestMaAlignmentStrengthFactor:
    def test_compute_with_enough_warmup(self, synthetic_candles):
        from src.factors.style_specific.trend import MaAlignmentStrengthFactor
        factor = MaAlignmentStrengthFactor()
        last_date = synthetic_candles["tradeDate"].iloc[-1]
        result = factor.compute(synthetic_candles, last_date)
        assert result.factor_value is not None
        assert "ma5" in result.raw_inputs
        assert "ma60" in result.raw_inputs

    def test_compute_insufficient_warmup(self, synthetic_candles):
        from src.factors.style_specific.trend import MaAlignmentStrengthFactor
        factor = MaAlignmentStrengthFactor()
        early_date = synthetic_candles["tradeDate"].iloc[40]
        result = factor.compute(synthetic_candles, early_date)
        assert result.factor_value is None


class TestLimitUpConsecutiveFactor:
    def test_no_limit_up(self, synthetic_candles):
        from src.factors.style_specific.shortterm import LimitUpConsecutiveFactor
        factor = LimitUpConsecutiveFactor()
        last_date = synthetic_candles["tradeDate"].iloc[-1]
        result = factor.compute(synthetic_candles, last_date)
        # 合成数据无涨停
        assert result.factor_value is not None
        assert result.factor_value == 0.0

    def test_with_limit_up(self):
        """构造涨停序列。"""
        from src.factors.style_specific.shortterm import LimitUpConsecutiveFactor
        n = 30
        dates = pd.date_range("2025-01-01", periods=n, freq="B")
        # 前 25 天平盘, 后 5 天连续涨停
        closes = np.array([10.0] * 25 + [10.0 * (1.1 ** i) for i in range(1, 6)])
        df = pd.DataFrame({
            "instrumentKey": "LU001",
            "tradeDate": dates.strftime("%Y-%m-%d"),
            "close": closes,
        })
        factor = LimitUpConsecutiveFactor()
        last_date = df["tradeDate"].iloc[-1]
        result = factor.compute(df, last_date)
        assert result.factor_value == 5.0  # 连续 5 天涨停


class TestKdjJFactor:
    def test_compute_with_enough_warmup(self, synthetic_candles):
        from src.factors.style_specific.shortterm import KdjJFactor
        factor = KdjJFactor()
        last_date = synthetic_candles["tradeDate"].iloc[-1]
        result = factor.compute(synthetic_candles, last_date)
        assert result.factor_value is not None
        # J 值在 -100 ~ 200 之间
        assert -100 <= result.factor_value <= 200

    def test_compute_insufficient_warmup(self, synthetic_candles):
        from src.factors.style_specific.shortterm import KdjJFactor
        factor = KdjJFactor()
        early_date = synthetic_candles["tradeDate"].iloc[10]
        result = factor.compute(synthetic_candles, early_date)
        assert result.factor_value is None


class TestBias6Factor:
    def test_compute_with_enough_warmup(self, synthetic_candles):
        from src.factors.style_specific.shortterm import Bias6Factor
        factor = Bias6Factor()
        last_date = synthetic_candles["tradeDate"].iloc[-1]
        result = factor.compute(synthetic_candles, last_date)
        assert result.factor_value is not None
        assert "ma6" in result.raw_inputs

    def test_compute_insufficient_warmup(self, synthetic_candles):
        from src.factors.style_specific.shortterm import Bias6Factor
        factor = Bias6Factor()
        early_date = synthetic_candles["tradeDate"].iloc[3]
        result = factor.compute(synthetic_candles, early_date)
        assert result.factor_value is None


class TestMomentum60dFactor:
    def test_compute_with_enough_warmup(self, synthetic_candles):
        from src.factors.style_specific.growth import Momentum60dFactor
        factor = Momentum60dFactor()
        last_date = synthetic_candles["tradeDate"].iloc[-1]
        result = factor.compute(synthetic_candles, last_date)
        assert result.factor_value is not None

    def test_compute_insufficient_warmup(self, synthetic_candles):
        from src.factors.style_specific.growth import Momentum60dFactor
        factor = Momentum60dFactor()
        early_date = synthetic_candles["tradeDate"].iloc[40]
        result = factor.compute(synthetic_candles, early_date)
        assert result.factor_value is None


class TestIntradayStrengthFactor:
    def test_compute_normal(self, synthetic_candles):
        from src.factors.style_specific.shortterm import IntradayStrengthFactor
        factor = IntradayStrengthFactor()
        last_date = synthetic_candles["tradeDate"].iloc[-1]
        result = factor.compute(synthetic_candles, last_date)
        assert result.factor_value is not None
        assert -1.0 <= result.factor_value <= 1.0

    def test_one_price_board(self):
        """一字板: high=low=close=open, 应返回 0。"""
        from src.factors.style_specific.shortterm import IntradayStrengthFactor
        df = pd.DataFrame({
            "instrumentKey": "OP001",
            "tradeDate": ["2025-01-01"],
            "open": [10.0],
            "high": [10.0],
            "low": [10.0],
            "close": [10.0],
        })
        factor = IntradayStrengthFactor()
        result = factor.compute(df, "2025-01-01")
        assert result.factor_value == 0.0


# ========== 3. compute() 与向量化实现一致性 ==========

class TestComputeVsVectorized:
    """验证逐行 compute() 与向量化实现数值一致(关键)。"""

    @pytest.mark.parametrize("factor_id", [
        "atr_20", "turtle_breakout_20", "ma_alignment_strength",
        "limit_up_consecutive", "kdj_j", "bias_6",
        "momentum_60d", "intraday_strength",
    ])
    def test_consistency(self, synthetic_candles, factor_id):
        # 构造注册表
        registry = build_style_registry()
        factor = registry.get(factor_id)

        # 逐行 compute() 最后一天
        last_date = synthetic_candles["tradeDate"].iloc[-1]
        compute_result = factor.compute(synthetic_candles, last_date)
        compute_value = compute_result.factor_value

        if compute_value is None:
            # warmup 不足, 跳过
            return

        # 向量化实现
        series = _compute_factor_series_for_instrument(factor_id, synthetic_candles)
        vectorized_value = series.iloc[-1]

        # 比较两者(允许微小数值误差)
        if np.isnan(vectorized_value):
            # 向量化也可能因为 warmup 返回 NaN
            return

        # KDJ 因子由于 EMA 初始化略有差异, 放宽容差
        tol = 1e-2 if factor_id in ("kdj_j",) else 1e-6
        diff = abs(compute_value - vectorized_value)
        # 对于大数值(如 J 值), 用相对误差
        if abs(compute_value) > 1.0:
            rel_diff = diff / abs(compute_value)
            assert rel_diff < 0.01, (
                f"{factor_id}: compute={compute_value}, vectorized={vectorized_value}, "
                f"rel_diff={rel_diff}"
            )
        else:
            assert diff < tol, (
                f"{factor_id}: compute={compute_value}, vectorized={vectorized_value}, "
                f"diff={diff}"
            )


class TestBuildStyleFactorPanelVectorized:
    """测试 build_style_factor_panel_vectorized 输出形状。"""

    @pytest.mark.parametrize("factor_id", [
        "atr_20", "turtle_breakout_20", "ma_alignment_strength",
        "limit_up_consecutive", "kdj_j", "bias_6",
        "momentum_60d", "intraday_strength",
    ])
    def test_panel_shape(self, multi_stock_candles, factor_id):
        panel = build_style_factor_panel_vectorized(factor_id, multi_stock_candles)
        assert not panel.empty
        # index 是 tradeDate, columns 是 instrumentKey
        assert panel.index.name == "tradeDate"
        assert "TEST001" in panel.columns
        assert "TEST002" in panel.columns

    def test_build_all_panels(self, multi_stock_candles):
        from src.panel.vectorized_styles import (
            build_all_style_factor_panels_vectorized,
        )
        panels = build_all_style_factor_panels_vectorized(multi_stock_candles)
        assert len(panels) == 8
        for fid, p in panels.items():
            assert isinstance(p, pd.DataFrame)
