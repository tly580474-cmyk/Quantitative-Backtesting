"""趋势型风格专属因子(3 个)。

供"趋势型(进取)"风格使用,核心理念:均线多头排列、突破信号、趋势延续。

因子清单:
- atr_20: ATR(20) 波动率(用于趋势跟踪仓位管理)
- turtle_breakout_20: 海龟 20 日突破强度
- ma_alignment_strength: 均线多头排列强度

实现约定:
1. 严格使用 _candles_up_to 截断到 signal_date,杜绝前视偏差
2. 调用 assert_point_in_time 做运行时断言
3. 因子值缺失返回 None,不抛异常
"""

from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd

from src.factors.base import (
    FactorBase,
    FactorComputeResult,
    FactorDefinition,
    FactorDirection,
)
from src.lookahead.assertions import assert_point_in_time


def _candles_up_to(candles: pd.DataFrame, signal_date: str) -> pd.DataFrame:
    """返回 tradeDate <= signal_date 的子集(防止未来数据)。"""
    mask = candles["tradeDate"] <= signal_date
    return candles[mask].copy()


def _sma(values: np.ndarray, period: int) -> float | None:
    """简单移动平均,返回最新一个值。"""
    if values is None or len(values) < period or period <= 0:
        return None
    return float(np.mean(values[-period:]))


def _safe_div(numerator: float, denominator: float) -> float | None:
    """安全除法,分母为 0 返回 None。"""
    if denominator == 0:
        return None
    return numerator / denominator


class AtrFactor(FactorBase):
    """ATR(20) 平均真实波幅。

    用于趋势跟踪仓位管理:ATR 大表示波动大,应减仓。
    direction=higher(趋势型偏好活跃波动,以捕捉大趋势)。
    """

    def definition(self) -> FactorDefinition:
        return FactorDefinition(
            id="atr_20",
            name="ATR(20)",
            description="20 日平均真实波幅 / 收盘价(标准化)",
            direction=FactorDirection.HIGHER_IS_BETTER,
            dependencies=("high", "low", "close"),
            warmup_days=21,
            tags=("trend", "volatility"),
        )

    def compute(self, candles: pd.DataFrame, signal_date: str) -> FactorComputeResult:
        df = _candles_up_to(candles, signal_date)
        assert_point_in_time(df, signal_date)
        if len(df) < 21:
            return FactorComputeResult(None, f"need 21 bars, got {len(df)}", {})
        highs = df["high"].values
        lows = df["low"].values
        closes = df["close"].values
        # TR = max(H-L, |H-prev_close|, |L-prev_close|)
        tr = np.zeros(len(df))
        tr[0] = highs[0] - lows[0]
        for i in range(1, len(df)):
            tr[i] = max(
                highs[i] - lows[i],
                abs(highs[i] - closes[i - 1]),
                abs(lows[i] - closes[i - 1]),
            )
        atr = _sma(tr, 20)
        if atr is None:
            return FactorComputeResult(None, "cannot compute ATR", {})
        close_now = float(closes[-1])
        atr_pct = _safe_div(atr, close_now)
        if atr_pct is None:
            return FactorComputeResult(None, "close is zero", {})
        return FactorComputeResult(
            float(atr_pct),
            f"ATR={atr:.4f}, close={close_now:.2f}, atr_pct={atr_pct:.4f}",
            {"atr": atr, "close": close_now, "atr_pct": atr_pct},
        )


class TurtleBreakoutFactor(FactorBase):
    """海龟 20 日突破强度。

    (close - high_20d_prev) / high_20d_prev,突破为正。
    严格使用前 20 日(不含当日)的 high 作为突破基准。
    """

    def definition(self) -> FactorDefinition:
        return FactorDefinition(
            id="turtle_breakout_20",
            name="海龟20日突破",
            description="(close - high_20d_prev) / high_20d_prev,突破为正",
            direction=FactorDirection.HIGHER_IS_BETTER,
            dependencies=("close", "high"),
            warmup_days=21,
            tags=("trend", "breakout"),
        )

    def compute(self, candles: pd.DataFrame, signal_date: str) -> FactorComputeResult:
        df = _candles_up_to(candles, signal_date)
        assert_point_in_time(df, signal_date)
        if len(df) < 21:
            return FactorComputeResult(None, f"need 21 bars, got {len(df)}", {})
        # 前 20 日(不含当日)的 high 作为突破基准
        recent = df.iloc[-21:-1]
        high_20d_prev = float(recent["high"].max())
        close_now = float(df["close"].values[-1])
        if high_20d_prev <= 0:
            return FactorComputeResult(None, "high_20d_prev <= 0", {})
        strength = _safe_div(close_now - high_20d_prev, high_20d_prev)
        if strength is None:
            return FactorComputeResult(None, "division error", {})
        return FactorComputeResult(
            float(strength),
            f"close={close_now:.2f}, high_20d_prev={high_20d_prev:.2f}, "
            f"strength={strength:.4f}",
            {"close": close_now, "high_20d_prev": high_20d_prev},
        )


class MaAlignmentStrengthFactor(FactorBase):
    """均线多头排列强度。

    0.4 × sign(MA5>MA10) × dist_5_10
  + 0.3 × sign(MA10>MA20) × dist_10_20
  + 0.3 × sign(MA20>MA60) × dist_20_60

    其中 dist = (ma_short - ma_long) / ma_long。
    多头排列时为正,空头排列时为负。
    """

    def definition(self) -> FactorDefinition:
        return FactorDefinition(
            id="ma_alignment_strength",
            name="均线多头排列强度",
            description="MA5/MA10/MA20/MA60 多头排列加权强度",
            direction=FactorDirection.HIGHER_IS_BETTER,
            dependencies=("close",),
            warmup_days=65,
            tags=("trend", "ma"),
        )

    def compute(self, candles: pd.DataFrame, signal_date: str) -> FactorComputeResult:
        df = _candles_up_to(candles, signal_date)
        assert_point_in_time(df, signal_date)
        if len(df) < 65:
            return FactorComputeResult(None, f"need 65 bars, got {len(df)}", {})
        closes = df["close"].values
        ma5 = _sma(closes, 5)
        ma10 = _sma(closes, 10)
        ma20 = _sma(closes, 20)
        ma60 = _sma(closes, 60)
        if any(v is None for v in (ma5, ma10, ma20, ma60)):
            return FactorComputeResult(None, "cannot compute MA", {})

        def _component(ma_short: float, ma_long: float, weight: float) -> float:
            if ma_long == 0:
                return 0.0
            sign = 1.0 if ma_short > ma_long else -1.0
            dist = (ma_short - ma_long) / ma_long
            return weight * sign * dist

        strength = (
            _component(ma5, ma10, 0.4)
            + _component(ma10, ma20, 0.3)
            + _component(ma20, ma60, 0.3)
        )
        return FactorComputeResult(
            float(strength),
            f"MA5={ma5:.2f}, MA10={ma10:.2f}, MA20={ma20:.2f}, MA60={ma60:.2f}, "
            f"strength={strength:.4f}",
            {"ma5": ma5, "ma10": ma10, "ma20": ma20, "ma60": ma60},
        )


# 因子列表(供注册表使用)
TREND_FACTORS: list[FactorBase] = [
    AtrFactor(),
    TurtleBreakoutFactor(),
    MaAlignmentStrengthFactor(),
]
