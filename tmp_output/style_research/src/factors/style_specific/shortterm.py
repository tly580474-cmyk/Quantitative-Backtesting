"""短线打板风格专属因子(4 个)。

供"短线打板(激进)"风格使用,核心理念:涨停接力、量价齐升、强势延续。

因子清单:
- limit_up_consecutive: 连续涨停天数(主板 10% 限制,阈值 9.5%)
- kdj_j: KDJ(9,3,3) 的 J 值
- bias_6: BIAS(6) 偏离率
- intraday_strength: 日内强度(收盘在日内位置)

实现约定同 technical.py。
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


# 主板涨跌停限制 10%,阈值取 9.5% 留 0.5% 缓冲
LIMIT_UP_THRESHOLD = 0.095


class LimitUpConsecutiveFactor(FactorBase):
    """连续涨停天数。

    从最近一日向前数,只要当日涨幅 >= 9.5% 视为涨停。
    因子值 = 连续涨停天数(0 表示无涨停)。
    """

    def definition(self) -> FactorDefinition:
        return FactorDefinition(
            id="limit_up_consecutive",
            name="连续涨停天数",
            description=f"最近连续涨停天数(阈值 {LIMIT_UP_THRESHOLD:.1%})",
            direction=FactorDirection.HIGHER_IS_BETTER,
            dependencies=("close",),
            warmup_days=2,
            tags=("short_term", "limit_up"),
        )

    def compute(self, candles: pd.DataFrame, signal_date: str) -> FactorComputeResult:
        df = _candles_up_to(candles, signal_date)
        assert_point_in_time(df, signal_date)
        if len(df) < 2:
            return FactorComputeResult(None, "need at least 2 bars", {})
        closes = df["close"].values.astype(float)
        # 计算每日涨幅(对前一日)
        count = 0
        for i in range(len(closes) - 1, 0, -1):
            ret = _safe_div(closes[i] - closes[i - 1], closes[i - 1])
            if ret is None:
                break
            if ret >= LIMIT_UP_THRESHOLD:
                count += 1
            else:
                break
        return FactorComputeResult(
            float(count),
            f"consecutive limit-up days: {count}",
            {"count": count},
        )


class KdjJFactor(FactorBase):
    """KDJ(9,3,3) 的 J 值。

    标准计算:
    RSV = (close - low_9d) / (high_9d - low_9d) × 100
    K = SMA(RSV, 3, 1)  # 即 EMA with alpha=1/3
    D = SMA(K, 3, 1)
    J = 3K - 2D
    J > 100 超买, J < 0 超卖。
    """

    def definition(self) -> FactorDefinition:
        return FactorDefinition(
            id="kdj_j",
            name="KDJ J 值",
            description="KDJ(9,3,3) 的 J 值,J>100 超买,J<0 超卖",
            direction=FactorDirection.HIGHER_IS_BETTER,
            dependencies=("close", "high", "low"),
            warmup_days=20,
            tags=("short_term", "oscillator"),
        )

    def compute(self, candles: pd.DataFrame, signal_date: str) -> FactorComputeResult:
        df = _candles_up_to(candles, signal_date)
        assert_point_in_time(df, signal_date)
        if len(df) < 20:
            return FactorComputeResult(None, f"need 20 bars, got {len(df)}", {})
        highs = df["high"].values.astype(float)
        lows = df["low"].values.astype(float)
        closes = df["close"].values.astype(float)
        n = len(df)
        # 计算 9 日 RSV
        rsv = np.full(n, 50.0)  # 默认 50
        for i in range(8, n):
            low_9 = lows[i - 8 : i + 1].min()
            high_9 = highs[i - 8 : i + 1].max()
            if high_9 > low_9:
                rsv[i] = (closes[i] - low_9) / (high_9 - low_9) * 100.0
        # SMA(RSV, 3, 1) = alpha=1/3 的 EMA
        k = np.full(n, 50.0)
        d = np.full(n, 50.0)
        for i in range(1, n):
            k[i] = (2 / 3) * k[i - 1] + (1 / 3) * rsv[i]
            d[i] = (2 / 3) * d[i - 1] + (1 / 3) * k[i]
        j = 3 * k - 2 * d
        j_now = float(j[-1])
        return FactorComputeResult(
            j_now,
            f"KDJ J={j_now:.2f}",
            {"j": j_now, "k": float(k[-1]), "d": float(d[-1])},
        )


class Bias6Factor(FactorBase):
    """BIAS(6) 偏离率。

    (close - MA6) / MA6 × 100%。
    偏离越大表示短期越强势。
    """

    def definition(self) -> FactorDefinition:
        return FactorDefinition(
            id="bias_6",
            name="BIAS(6)",
            description="(close - MA6) / MA6,6 日偏离率",
            direction=FactorDirection.HIGHER_IS_BETTER,
            dependencies=("close",),
            warmup_days=6,
            tags=("short_term", "bias"),
        )

    def compute(self, candles: pd.DataFrame, signal_date: str) -> FactorComputeResult:
        df = _candles_up_to(candles, signal_date)
        assert_point_in_time(df, signal_date)
        if len(df) < 6:
            return FactorComputeResult(None, f"need 6 bars, got {len(df)}", {})
        closes = df["close"].values.astype(float)
        ma6 = _sma(closes, 6)
        if ma6 is None or ma6 == 0:
            return FactorComputeResult(None, "cannot compute MA6", {})
        close_now = float(closes[-1])
        bias = _safe_div(close_now - ma6, ma6)
        if bias is None:
            return FactorComputeResult(None, "division error", {})
        return FactorComputeResult(
            float(bias),
            f"close={close_now:.2f}, MA6={ma6:.2f}, bias={bias:.4f}",
            {"close": close_now, "ma6": ma6, "bias": bias},
        )


class IntradayStrengthFactor(FactorBase):
    """日内强度。

    (close - open) / (high - low),表示收盘价在日内区间的位置。
    +1 = 收盘在最高点, -1 = 收盘在最低点, 0 = 中间。
    """

    def definition(self) -> FactorDefinition:
        return FactorDefinition(
            id="intraday_strength",
            name="日内强度",
            description="(close - open) / (high - low),收盘在日内位置",
            direction=FactorDirection.HIGHER_IS_BETTER,
            dependencies=("open", "high", "low", "close"),
            warmup_days=1,
            tags=("short_term", "intraday"),
        )

    def compute(self, candles: pd.DataFrame, signal_date: str) -> FactorComputeResult:
        df = _candles_up_to(candles, signal_date)
        assert_point_in_time(df, signal_date)
        if len(df) < 1:
            return FactorComputeResult(None, "need at least 1 bar", {})
        o = float(df["open"].values[-1])
        h = float(df["high"].values[-1])
        l = float(df["low"].values[-1])
        c = float(df["close"].values[-1])
        hl_range = h - l
        if hl_range <= 0:
            # 一字板,无法判断,返回中性 0
            return FactorComputeResult(
                0.0,
                f"one-price board, range=0",
                {"open": o, "high": h, "low": l, "close": c, "strength": 0.0},
            )
        strength = (c - o) / hl_range
        # clip 到 [-1, 1]
        strength = max(-1.0, min(1.0, strength))
        return FactorComputeResult(
            float(strength),
            f"open={o:.2f}, high={h:.2f}, low={l:.2f}, close={c:.2f}, "
            f"strength={strength:.4f}",
            {"open": o, "high": h, "low": l, "close": c, "strength": strength},
        )


# 因子列表(供注册表使用)
SHORTTERM_FACTORS: list[FactorBase] = [
    LimitUpConsecutiveFactor(),
    KdjJFactor(),
    Bias6Factor(),
    IntradayStrengthFactor(),
]
