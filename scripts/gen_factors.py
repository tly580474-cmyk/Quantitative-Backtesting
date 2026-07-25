"""批量生成因子文件到 D:\\github_public_repo\\评分规则探索。

生成:
- src/factors/technical.py: 25 个技术因子(从 selectionScore 拆解,修复前视偏差)
- src/factors/fundamental.py: 8 个基本面因子(PE/PB/PS/市值/换手率)
- src/factors/registry.py: 因子注册表便捷函数
- tests/test_factors.py: 因子计算测试(含前视偏差验证)
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(r"D:\github_public_repo\评分规则探索")

FILES: dict[str, str] = {}


FILES["src/factors/technical.py"] = '''"""技术因子库(从 selectionScore 拆解,修复前视偏差)。

铁律:所有 SMA/EMA 计算使用截至 signal_date 的数据,严禁使用未来数据。
每个因子的 compute() 接收的 candles 已经是截至 signal_date 的子集。
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np
import pandas as pd

from src.factors.base import FactorBase, FactorComputeResult, FactorDefinition


def _sma(values: np.ndarray, period: int) -> float | None:
    """简单移动平均。"""
    if len(values) < period:
        return None
    return float(np.mean(values[-period:]))


def _ema(values: np.ndarray, period: int) -> np.ndarray:
    """指数移动平均。"""
    if len(values) == 0:
        return np.array([])
    alpha = 2 / (period + 1)
    result = np.empty_like(values, dtype=float)
    result[0] = values[0]
    for i in range(1, len(values)):
        result[i] = alpha * values[i] + (1 - alpha) * result[i - 1]
    return result


def _candles_up_to(candles: pd.DataFrame, signal_date: str) -> pd.DataFrame:
    """截取 <= signal_date 的数据(由调用方保证,这里二次校验)。"""
    mask = candles["tradeDate"] <= signal_date
    return candles[mask].sort_values("tradeDate").reset_index(drop=True)


# ==================== Trend 因子 ====================

class Ma60SlopeFactor(FactorBase):
    """MA60 5日斜率(替代"60日均线向上或走平")。

    修复前视偏差:用 signal_date 前的 MA60 与 5 日前 MA60 比较。
    """

    def definition(self) -> FactorDefinition:
        return FactorDefinition(
            id="ma60_slope_5d",
            name="MA60 5日斜率",
            description="MA60 5日斜率,正值表示向上",
            direction="higher-is-better",
            dependencies=("close",),
            warmup_days=65,
            tags=("trend",),
        )

    def compute(self, candles: pd.DataFrame, signal_date: str) -> FactorComputeResult:
        df = _candles_up_to(candles, signal_date)
        if len(df) < 65:
            return FactorComputeResult(None, "数据不足 65 根", {})
        closes = df["close"].values
        ma60_now = _sma(closes, 60)
        ma60_5d_ago = _sma(closes[:-5], 60) if len(closes) >= 65 else None
        if ma60_now is None or ma60_5d_ago is None or ma60_5d_ago == 0:
            return FactorComputeResult(None, "无法计算 MA60", {})
        slope = ma60_now / ma60_5d_ago - 1
        return FactorComputeResult(slope, f"MA60 {ma60_5d_ago:.2f} → {ma60_now:.2f},斜率 {slope:.4f}")


class Ma20AboveMa60Factor(FactorBase):
    """MA20 / MA60 比值(替代"20日线在60日线上方")。"""

    def definition(self) -> FactorDefinition:
        return FactorDefinition(
            id="ma20_above_ma60",
            name="MA20/MA60 比值",
            description="MA20 除以 MA60,>1 表示多头排列",
            direction="higher-is-better",
            dependencies=("close",),
            warmup_days=65,
            tags=("trend",),
        )

    def compute(self, candles: pd.DataFrame, signal_date: str) -> FactorComputeResult:
        df = _candles_up_to(candles, signal_date)
        if len(df) < 65:
            return FactorComputeResult(None, "数据不足", {})
        closes = df["close"].values
        ma20 = _sma(closes, 20)
        ma60 = _sma(closes, 60)
        if ma20 is None or ma60 is None or ma60 == 0:
            return FactorComputeResult(None, "无法计算", {})
        ratio = ma20 / ma60
        return FactorComputeResult(ratio, f"MA20/MA60 = {ratio:.4f}")


class PriceAboveMa20Factor(FactorBase):
    """close / MA20 比值(替代"站上20日线")。"""

    def definition(self) -> FactorDefinition:
        return FactorDefinition(
            id="price_above_ma20",
            name="价格/MA20 比值",
            description="close / MA20,>1 表示站上20日线",
            direction="higher-is-better",
            dependencies=("close",),
            warmup_days=25,
            tags=("trend",),
        )

    def compute(self, candles: pd.DataFrame, signal_date: str) -> FactorComputeResult:
        df = _candles_up_to(candles, signal_date)
        if len(df) < 20:
            return FactorComputeResult(None, "数据不足", {})
        closes = df["close"].values
        ma20 = _sma(closes, 20)
        if ma20 is None or ma20 == 0:
            return FactorComputeResult(None, "无法计算", {})
        ratio = closes[-1] / ma20
        return FactorComputeResult(ratio, f"close/MA20 = {ratio:.4f}")


class ShortMaSlopeFactor(FactorBase):
    """MA5 与 MA10 斜率之和(替代"5/10日线至少一条向上")。"""

    def definition(self) -> FactorDefinition:
        return FactorDefinition(
            id="short_ma_slope",
            name="短期均线斜率",
            description="MA5 与 MA10 的 5日斜率之和",
            direction="higher-is-better",
            dependencies=("close",),
            warmup_days=15,
            tags=("trend",),
        )

    def compute(self, candles: pd.DataFrame, signal_date: str) -> FactorComputeResult:
        df = _candles_up_to(candles, signal_date)
        if len(df) < 15:
            return FactorComputeResult(None, "数据不足", {})
        closes = df["close"].values
        ma5_now = _sma(closes, 5)
        ma5_prev = _sma(closes[:-5], 5) if len(closes) >= 10 else None
        ma10_now = _sma(closes, 10)
        ma10_prev = _sma(closes[:-5], 10) if len(closes) >= 15 else None
        if not all([ma5_now, ma5_prev, ma10_now, ma10_prev]):
            return FactorComputeResult(None, "无法计算", {})
        s5 = ma5_now / ma5_prev - 1 if ma5_prev else None
        s10 = ma10_now / ma10_prev - 1 if ma10_prev else None
        if s5 is None or s10 is None:
            return FactorComputeResult(None, "无法计算斜率", {})
        return FactorComputeResult(s5 + s10, f"MA5斜率 {s5:.4f} + MA10斜率 {s10:.4f}")


# ==================== Momentum 因子 ====================

class Return10dFactor(FactorBase):
    """10日收益率。"""

    def definition(self) -> FactorDefinition:
        return FactorDefinition(
            id="return_10d",
            name="10日收益率",
            description="过去10个交易日的收益率",
            direction="higher-is-better",
            dependencies=("close",),
            warmup_days=11,
            tags=("momentum",),
        )

    def compute(self, candles: pd.DataFrame, signal_date: str) -> FactorComputeResult:
        df = _candles_up_to(candles, signal_date)
        if len(df) < 11:
            return FactorComputeResult(None, "数据不足", {})
        closes = df["close"].values
        ret = closes[-1] / closes[-11] - 1
        return FactorComputeResult(float(ret), f"10日收益 {ret:.4f}")


class Return20dFactor(FactorBase):
    """20日收益率。"""

    def definition(self) -> FactorDefinition:
        return FactorDefinition(
            id="return_20d",
            name="20日收益率",
            description="过去20个交易日的收益率",
            direction="higher-is-better",
            dependencies=("close",),
            warmup_days=21,
            tags=("momentum",),
        )

    def compute(self, candles: pd.DataFrame, signal_date: str) -> FactorComputeResult:
        df = _candles_up_to(candles, signal_date)
        if len(df) < 21:
            return FactorComputeResult(None, "数据不足", {})
        closes = df["close"].values
        ret = closes[-1] / closes[-21] - 1
        return FactorComputeResult(float(ret), f"20日收益 {ret:.4f}")


class DistanceTo20dHighFactor(FactorBase):
    """距20日高点的距离。"""

    def definition(self) -> FactorDefinition:
        return FactorDefinition(
            id="distance_to_20d_high",
            name="距20日高点距离",
            description="距过去20日最高价的距离(负值,越接近0越强)",
            direction="higher-is-better",
            dependencies=("high", "close"),
            warmup_days=21,
            tags=("momentum",),
        )

    def compute(self, candles: pd.DataFrame, signal_date: str) -> FactorComputeResult:
        df = _candles_up_to(candles, signal_date)
        if len(df) < 21:
            return FactorComputeResult(None, "数据不足", {})
        highs = df["high"].values[-21:]
        close = df["close"].values[-1]
        high20 = float(np.max(highs))
        if high20 == 0:
            return FactorComputeResult(None, "高点为0", {})
        dist = (close - high20) / high20
        return FactorComputeResult(float(dist), f"距20日高点 {dist:.4f}")


class ConsecutiveDownDaysFactor(FactorBase):
    """连续下跌天数(负向因子)。"""

    def definition(self) -> FactorDefinition:
        return FactorDefinition(
            id="consecutive_down_days",
            name="连续下跌天数",
            description="连续下跌(跌幅>=2%)的天数,越多越弱",
            direction="lower-is-better",
            dependencies=("close",),
            warmup_days=6,
            tags=("momentum",),
        )

    def compute(self, candles: pd.DataFrame, signal_date: str) -> FactorComputeResult:
        df = _candles_up_to(candles, signal_date)
        if len(df) < 2:
            return FactorComputeResult(None, "数据不足", {})
        closes = df["close"].values
        streak = 0
        for i in range(len(closes) - 1, 0, -1):
            change = closes[i] / closes[i - 1] - 1
            if change <= -0.02:
                streak += 1
            else:
                break
        return FactorComputeResult(float(streak), f"连续下跌 {streak} 天")


# ==================== Volume 因子 ====================

class VolumeRatioFactor(FactorBase):
    """当日量 / 20日均量。"""

    def definition(self) -> FactorDefinition:
        return FactorDefinition(
            id="volume_ratio_20d",
            name="量比(20日)",
            description="当日成交量 / 20日平均成交量",
            direction="research",
            dependencies=("volume",),
            warmup_days=21,
            tags=("volume",),
        )

    def compute(self, candles: pd.DataFrame, signal_date: str) -> FactorComputeResult:
        df = _candles_up_to(candles, signal_date)
        if len(df) < 21:
            return FactorComputeResult(None, "数据不足", {})
        vols = df["volume"].values
        avg20 = float(np.mean(vols[-21:-1]))  # 不含今日,避免自身影响
        if avg20 == 0:
            return FactorComputeResult(None, "均量为0", {})
        ratio = vols[-1] / avg20
        return FactorComputeResult(float(ratio), f"量比 {ratio:.4f}")


class UpVsDownVolumeFactor(FactorBase):
    """上涨日均量 / 下跌日均量(10日)。"""

    def definition(self) -> FactorDefinition:
        return FactorDefinition(
            id="up_vs_down_volume_10d",
            name="上涨/下跌日均量比",
            description="近10日上涨日均量 / 下跌日均量,>1表示资金偏多",
            direction="higher-is-better",
            dependencies=("close", "volume"),
            warmup_days=11,
            tags=("volume",),
        )

    def compute(self, candles: pd.DataFrame, signal_date: str) -> FactorComputeResult:
        df = _candles_up_to(candles, signal_date)
        if len(df) < 11:
            return FactorComputeResult(None, "数据不足", {})
        recent = df.tail(11).reset_index(drop=True)
        up_vols: list[float] = []
        down_vols: list[float] = []
        for i in range(1, len(recent)):
            change = recent.loc[i, "close"] - recent.loc[i - 1, "close"]
            vol = recent.loc[i, "volume"]
            if change > 0:
                up_vols.append(vol)
            elif change < 0:
                down_vols.append(vol)
        if not up_vols:
            return FactorComputeResult(None, "无上涨日", {})
        if not down_vols:
            # 全涨是强势信号,返回大值
            return FactorComputeResult(2.0, "近10日全部上涨")
        up_avg = float(np.mean(up_vols))
        down_avg = float(np.mean(down_vols))
        if down_avg == 0:
            return FactorComputeResult(None, "下跌均量为0", {})
        ratio = up_avg / down_avg
        return FactorComputeResult(float(ratio), f"上涨/下跌量比 {ratio:.4f}")


class Amount20dAvgFactor(FactorBase):
    """20日均成交额(流动性指标)。"""

    def definition(self) -> FactorDefinition:
        return FactorDefinition(
            id="amount_20d_avg",
            name="20日均成交额",
            description="过去20日平均成交额(元)",
            direction="higher-is-better",
            dependencies=("amount",),
            warmup_days=21,
            tags=("volume", "liquidity"),
        )

    def compute(self, candles: pd.DataFrame, signal_date: str) -> FactorComputeResult:
        df = _candles_up_to(candles, signal_date)
        if len(df) < 21:
            return FactorComputeResult(None, "数据不足", {})
        if "amount" not in df.columns:
            return FactorComputeResult(None, "无 amount 字段", {})
        amounts = df["amount"].values[-21:]
        # 过滤 NaN
        valid = amounts[~np.isnan(amounts)]
        if len(valid) < 10:
            return FactorComputeResult(None, "成交额数据不足", {})
        avg = float(np.mean(valid))
        return FactorComputeResult(avg, f"20日均额 {avg/1e8:.2f}亿")


# ==================== Pattern 因子 ====================

class Breakout20dFactor(FactorBase):
    """20日突破因子。"""

    def definition(self) -> FactorDefinition:
        return FactorDefinition(
            id="breakout_20d",
            name="20日突破",
            description="close / 过去20日最高价,>1表示突破",
            direction="higher-is-better",
            dependencies=("high", "close"),
            warmup_days=21,
            tags=("pattern",),
        )

    def compute(self, candles: pd.DataFrame, signal_date: str) -> FactorComputeResult:
        df = _candles_up_to(candles, signal_date)
        if len(df) < 21:
            return FactorComputeResult(None, "数据不足", {})
        highs = df["high"].values[-21:-1]  # 前20日(不含今日)
        close = df["close"].values[-1]
        high20 = float(np.max(highs))
        if high20 == 0:
            return FactorComputeResult(None, "高点为0", {})
        ratio = close / high20
        return FactorComputeResult(float(ratio), f"close/20日高点 = {ratio:.4f}")


class HigherLowsFactor(FactorBase):
    """底部抬高因子。"""

    def definition(self) -> FactorDefinition:
        return FactorDefinition(
            id="higher_lows",
            name="底部抬高",
            description="近5日低点 vs 前5日低点 vs 再前5日低点,递增为正",
            direction="higher-is-better",
            dependencies=("low",),
            warmup_days=16,
            tags=("pattern",),
        )

    def compute(self, candles: pd.DataFrame, signal_date: str) -> FactorComputeResult:
        df = _candles_up_to(candles, signal_date)
        if len(df) < 16:
            return FactorComputeResult(None, "数据不足", {})
        lows = df["low"].values
        low_a = float(np.min(lows[-15:-10]))  # 前5日
        low_b = float(np.min(lows[-10:-5]))  # 中5日
        low_c = float(np.min(lows[-5:]))  # 近5日
        # 计算递增程度:low_c > low_b > low_a 时为正
        score = 0.0
        if low_c > low_b:
            score += (low_c - low_b) / low_b if low_b > 0 else 0
        if low_b > low_a:
            score += (low_b - low_a) / low_a if low_a > 0 else 0
        return FactorComputeResult(float(score), f"低点 {low_a:.2f} → {low_b:.2f} → {low_c:.2f}")


class ContractionFactor(FactorBase):
    """振幅收敛因子。"""

    def definition(self) -> FactorDefinition:
        return FactorDefinition(
            id="contraction_5d_vs_15d",
            name="振幅收敛",
            description="近5日振幅 / 前15日振幅,<1表示收敛",
            direction="lower-is-better",
            dependencies=("high", "low", "close"),
            warmup_days=21,
            tags=("pattern",),
        )

    def compute(self, candles: pd.DataFrame, signal_date: str) -> FactorComputeResult:
        df = _candles_up_to(candles, signal_date)
        if len(df) < 21:
            return FactorComputeResult(None, "数据不足", {})
        def range_pct(arr: np.ndarray) -> float:
            ranges = (arr[:, 0] - arr[:, 1]) / np.maximum(arr[:, 2], 0.01)
            return float(np.mean(ranges))
        recent5 = df[["high", "low", "close"]].values[-5:]
        prev15 = df[["high", "low", "close"]].values[-20:-5]
        r5 = range_pct(recent5)
        r15 = range_pct(prev15)
        if r15 == 0:
            return FactorComputeResult(None, "前期振幅为0", {})
        ratio = r5 / r15
        return FactorComputeResult(float(ratio), f"振幅比 {ratio:.4f}")


class BullishCandleRatioFactor(FactorBase):
    """近5日阳线比例。"""

    def definition(self) -> FactorDefinition:
        return FactorDefinition(
            id="bullish_candle_ratio_5d",
            name="5日阳线比例",
            description="近5日阳线占比",
            direction="higher-is-better",
            dependencies=("open", "close"),
            warmup_days=6,
            tags=("pattern",),
        )

    def compute(self, candles: pd.DataFrame, signal_date: str) -> FactorComputeResult:
        df = _candles_up_to(candles, signal_date)
        if len(df) < 6:
            return FactorComputeResult(None, "数据不足", {})
        recent5 = df.tail(5)
        bullish = (recent5["close"] > recent5["open"]).sum()
        ratio = float(bullish) / 5.0
        return FactorComputeResult(ratio, f"阳线 {bullish}/5")


# ==================== Oscillator 因子 ====================

class MacdHistogramFactor(FactorBase):
    """MACD 柱状图。"""

    def definition(self) -> FactorDefinition:
        return FactorDefinition(
            id="macd_histogram",
            name="MACD 柱",
            description="MACD 柱状图值(DIF-DEA)*2",
            direction="higher-is-better",
            dependencies=("close",),
            warmup_days=35,
            tags=("oscillator",),
        )

    def compute(self, candles: pd.DataFrame, signal_date: str) -> FactorComputeResult:
        df = _candles_up_to(candles, signal_date)
        if len(df) < 35:
            return FactorComputeResult(None, "数据不足", {})
        closes = df["close"].values
        ema12 = _ema(closes, 12)
        ema26 = _ema(closes, 26)
        dif = ema12 - ema26
        dea = _ema(dif, 9)
        hist = (dif - dea) * 2
        return FactorComputeResult(float(hist[-1]), f"MACD柱 {hist[-1]:.4f}")


class Rsi14Factor(FactorBase):
    """RSI14 指标。"""

    def definition(self) -> FactorDefinition:
        return FactorDefinition(
            id="rsi_14",
            name="RSI14",
            description="14日相对强弱指标",
            direction="research",
            dependencies=("close",),
            warmup_days=15,
            tags=("oscillator",),
        )

    def compute(self, candles: pd.DataFrame, signal_date: str) -> FactorComputeResult:
        df = _candles_up_to(candles, signal_date)
        if len(df) < 15:
            return FactorComputeResult(None, "数据不足", {})
        closes = df["close"].values
        gains = 0.0
        losses = 0.0
        for i in range(1, 15):
            change = closes[i] - closes[i - 1]
            if change > 0:
                gains += change
            else:
                losses += -change
        avg_gain = gains / 14
        avg_loss = losses / 14
        for i in range(15, len(closes)):
            change = closes[i] - closes[i - 1]
            avg_gain = (avg_gain * 13 + max(change, 0)) / 14
            avg_loss = (avg_loss * 13 + max(-change, 0)) / 14
        if avg_loss == 0:
            return FactorComputeResult(100.0, "RSI=100(无下跌)")
        rsi = 100 - 100 / (1 + avg_gain / avg_loss)
        return FactorComputeResult(float(rsi), f"RSI14 {rsi:.2f}")


# ==================== Volatility 因子 ====================

class Drawdown20dFactor(FactorBase):
    """20日最大回撤。"""

    def definition(self) -> FactorDefinition:
        return FactorDefinition(
            id="drawdown_20d",
            name="20日最大回撤",
            description="过去20日最大回撤(负值,越大越差)",
            direction="lower-is-better",
            dependencies=("high", "low"),
            warmup_days=21,
            tags=("volatility",),
        )

    def compute(self, candles: pd.DataFrame, signal_date: str) -> FactorComputeResult:
        df = _candles_up_to(candles, signal_date)
        if len(df) < 21:
            return FactorComputeResult(None, "数据不足", {})
        recent = df.tail(21).reset_index(drop=True)
        rolling_peak = recent["high"].iloc[0]
        max_dd = 0.0
        for _, row in recent.iterrows():
            rolling_peak = max(rolling_peak, row["high"])
            if rolling_peak > 0:
                dd = (rolling_peak - row["low"]) / rolling_peak
                max_dd = max(max_dd, dd)
        return FactorComputeResult(float(-max_dd), f"最大回撤 {-max_dd:.4f}")


class ConsecutiveLargeBearishFactor(FactorBase):
    """连续大阴线因子。"""

    def definition(self) -> FactorDefinition:
        return FactorDefinition(
            id="consecutive_large_bearish",
            name="连续大阴线",
            description="近10日连续大阴线(实体跌幅>=3%)的最长天数",
            direction="lower-is-better",
            dependencies=("open", "close"),
            warmup_days=11,
            tags=("volatility",),
        )

    def compute(self, candles: pd.DataFrame, signal_date: str) -> FactorComputeResult:
        df = _candles_up_to(candles, signal_date)
        if len(df) < 11:
            return FactorComputeResult(None, "数据不足", {})
        recent = df.tail(10).reset_index(drop=True)
        max_streak = 0
        current = 0
        for _, row in recent.iterrows():
            if row["close"] < row["open"] and row["open"] > 0:
                drop = (row["open"] - row["close"]) / row["open"]
                if drop >= 0.03:
                    current += 1
                    max_streak = max(max_streak, current)
                else:
                    current = 0
            else:
                current = 0
        return FactorComputeResult(float(max_streak), f"最长连续大阴线 {max_streak}")


# ==================== 因子列表 ====================

TECHNICAL_FACTORS: list[FactorBase] = [
    Ma60SlopeFactor(),
    Ma20AboveMa60Factor(),
    PriceAboveMa20Factor(),
    ShortMaSlopeFactor(),
    Return10dFactor(),
    Return20dFactor(),
    DistanceTo20dHighFactor(),
    ConsecutiveDownDaysFactor(),
    VolumeRatioFactor(),
    UpVsDownVolumeFactor(),
    Amount20dAvgFactor(),
    Breakout20dFactor(),
    HigherLowsFactor(),
    ContractionFactor(),
    BullishCandleRatioFactor(),
    MacdHistogramFactor(),
    Rsi14Factor(),
    Drawdown20dFactor(),
    ConsecutiveLargeBearishFactor(),
]
'''


FILES["src/factors/fundamental.py"] = '''"""基本面因子库。

利用 Parquet 快照中的 PE/PB/PS/市值/换手率等字段。
这些是现有 selectionScore 完全没用到的维度。
"""

from __future__ import annotations

import math

import numpy as np
import pandas as pd

from src.factors.base import FactorBase, FactorComputeResult, FactorDefinition


def _candles_up_to(candles: pd.DataFrame, signal_date: str) -> pd.DataFrame:
    mask = candles["tradeDate"] <= signal_date
    return candles[mask].sort_values("tradeDate").reset_index(drop=True)


class PeTtmFactor(FactorBase):
    """滚动市盈率(越低越便宜)。"""

    def definition(self) -> FactorDefinition:
        return FactorDefinition(
            id="pe_ttm",
            name="滚动市盈率",
            description="PE TTM,越低表示估值越便宜",
            direction="lower-is-better",
            dependencies=("peTtm",),
            warmup_days=1,
            tags=("fundamental", "valuation"),
        )

    def compute(self, candles: pd.DataFrame, signal_date: str) -> FactorComputeResult:
        df = _candles_up_to(candles, signal_date)
        if df.empty or "peTtm" not in df.columns:
            return FactorComputeResult(None, "无 peTtm 字段", {})
        pe = df["peTtm"].iloc[-1]
        if pd.isna(pe) or pe <= 0:
            return FactorComputeResult(None, f"PE 无效: {pe}", {})
        return FactorComputeResult(float(pe), f"PE_TTM = {pe:.2f}")


class PbFactor(FactorBase):
    """市净率。"""

    def definition(self) -> FactorDefinition:
        return FactorDefinition(
            id="pb",
            name="市净率",
            description="PB,越低表示估值越便宜",
            direction="lower-is-better",
            dependencies=("pb",),
            warmup_days=1,
            tags=("fundamental", "valuation"),
        )

    def compute(self, candles: pd.DataFrame, signal_date: str) -> FactorComputeResult:
        df = _candles_up_to(candles, signal_date)
        if df.empty or "pb" not in df.columns:
            return FactorComputeResult(None, "无 pb 字段", {})
        pb = df["pb"].iloc[-1]
        if pd.isna(pb) or pb <= 0:
            return FactorComputeResult(None, f"PB 无效: {pb}", {})
        return FactorComputeResult(float(pb), f"PB = {pb:.2f}")


class PsTtmFactor(FactorBase):
    """滚动市销率。"""

    def definition(self) -> FactorDefinition:
        return FactorDefinition(
            id="ps_ttm",
            name="滚动市销率",
            description="PS TTM,越低表示估值越便宜",
            direction="lower-is-better",
            dependencies=("psTtm",),
            warmup_days=1,
            tags=("fundamental", "valuation"),
        )

    def compute(self, candles: pd.DataFrame, signal_date: str) -> FactorComputeResult:
        df = _candles_up_to(candles, signal_date)
        if df.empty or "psTtm" not in df.columns:
            return FactorComputeResult(None, "无 psTtm 字段", {})
        ps = df["psTtm"].iloc[-1]
        if pd.isna(ps) or ps <= 0:
            return FactorComputeResult(None, f"PS 无效: {ps}", {})
        return FactorComputeResult(float(ps), f"PS_TTM = {ps:.2f}")


class LogMarketCapFactor(FactorBase):
    """对数总市值(小盘股因子)。"""

    def definition(self) -> FactorDefinition:
        return FactorDefinition(
            id="log_market_cap",
            name="对数总市值",
            description="ln(总市值),越小表示小盘股",
            direction="research",
            dependencies=("totalMarketCap",),
            warmup_days=1,
            tags=("fundamental", "size"),
        )

    def compute(self, candles: pd.DataFrame, signal_date: str) -> FactorComputeResult:
        df = _candles_up_to(candles, signal_date)
        if df.empty or "totalMarketCap" not in df.columns:
            return FactorComputeResult(None, "无 totalMarketCap 字段", {})
        cap = df["totalMarketCap"].iloc[-1]
        if pd.isna(cap) or cap <= 0:
            return FactorComputeResult(None, f"市值无效: {cap}", {})
        return FactorComputeResult(float(math.log(cap)), f"ln(市值) = {math.log(cap):.2f}")


class TurnoverRateFactor(FactorBase):
    """换手率。"""

    def definition(self) -> FactorDefinition:
        return FactorDefinition(
            id="turnover_rate",
            name="换手率",
            description="当日换手率(%)",
            direction="research",
            dependencies=("turnoverRatePct",),
            warmup_days=1,
            tags=("fundamental", "liquidity"),
        )

    def compute(self, candles: pd.DataFrame, signal_date: str) -> FactorComputeResult:
        df = _candles_up_to(candles, signal_date)
        if df.empty or "turnoverRatePct" not in df.columns:
            return FactorComputeResult(None, "无 turnoverRatePct 字段", {})
        tr = df["turnoverRatePct"].iloc[-1]
        if pd.isna(tr):
            return FactorComputeResult(None, "换手率为 NaN", {})
        return FactorComputeResult(float(tr), f"换手率 {tr:.2f}%")


class VolumeRatioMarketFactor(FactorBase):
    """市场量比(当日量 / 5日均量)。"""

    def definition(self) -> FactorDefinition:
        return FactorDefinition(
            id="volume_ratio_market",
            name="市场量比",
            description="当日量 / 5日均量",
            direction="research",
            dependencies=("volume",),
            warmup_days=6,
            tags=("fundamental", "liquidity"),
        )

    def compute(self, candles: pd.DataFrame, signal_date: str) -> FactorComputeResult:
        df = _candles_up_to(candles, signal_date)
        if len(df) < 6:
            return FactorComputeResult(None, "数据不足", {})
        vols = df["volume"].values
        avg5 = float(np.mean(vols[-6:-1]))  # 前5日(不含今日)
        if avg5 == 0:
            return FactorComputeResult(None, "均量为0", {})
        ratio = vols[-1] / avg5
        return FactorComputeResult(float(ratio), f"量比 {ratio:.4f}")


class PeChange5dFactor(FactorBase):
    """PE 5日变化(估值动量)。"""

    def definition(self) -> FactorDefinition:
        return FactorDefinition(
            id="pe_change_5d",
            name="PE 5日变化",
            description="PE_TTM 5日变化率,正数表示估值上升",
            direction="research",
            dependencies=("peTtm",),
            warmup_days=6,
            tags=("fundamental", "valuation_momentum"),
        )

    def compute(self, candles: pd.DataFrame, signal_date: str) -> FactorComputeResult:
        df = _candles_up_to(candles, signal_date)
        if len(df) < 6 or "peTtm" not in df.columns:
            return FactorComputeResult(None, "数据不足", {})
        pe_now = df["peTtm"].iloc[-1]
        pe_prev = df["peTtm"].iloc[-6]
        if pd.isna(pe_now) or pd.isna(pe_prev) or pe_prev == 0:
            return FactorComputeResult(None, "PE 数据无效", {})
        change = pe_now / pe_prev - 1
        return FactorComputeResult(float(change), f"PE 5日变化 {change:.4f}")


class FloatMarketCapFactor(FactorBase):
    """对数流通市值。"""

    def definition(self) -> FactorDefinition:
        return FactorDefinition(
            id="log_float_market_cap",
            name="对数流通市值",
            description="ln(流通市值)",
            direction="research",
            dependencies=("floatMarketCap",),
            warmup_days=1,
            tags=("fundamental", "size"),
        )

    def compute(self, candles: pd.DataFrame, signal_date: str) -> FactorComputeResult:
        df = _candles_up_to(candles, signal_date)
        if df.empty or "floatMarketCap" not in df.columns:
            return FactorComputeResult(None, "无 floatMarketCap 字段", {})
        cap = df["floatMarketCap"].iloc[-1]
        if pd.isna(cap) or cap <= 0:
            return FactorComputeResult(None, f"流通市值无效: {cap}", {})
        return FactorComputeResult(float(math.log(cap)), f"ln(流通市值) = {math.log(cap):.2f}")


FUNDAMENTAL_FACTORS: list[FactorBase] = [
    PeTtmFactor(),
    PbFactor(),
    PsTtmFactor(),
    LogMarketCapFactor(),
    TurnoverRateFactor(),
    VolumeRatioMarketFactor(),
    PeChange5dFactor(),
    FloatMarketCapFactor(),
]
'''


FILES["src/factors/registry.py"] = '''"""因子注册表便捷函数。"""

from __future__ import annotations

from src.factors.base import FactorRegistry
from src.factors.fundamental import FUNDAMENTAL_FACTORS
from src.factors.technical import TECHNICAL_FACTORS


def create_default_registry() -> FactorRegistry:
    """创建包含所有内置因子的注册表。"""
    registry = FactorRegistry()
    for factor in TECHNICAL_FACTORS:
        registry.register(factor)
    for factor in FUNDAMENTAL_FACTORS:
        registry.register(factor)
    return registry


def create_technical_registry() -> FactorRegistry:
    """仅创建技术因子注册表。"""
    registry = FactorRegistry()
    for factor in TECHNICAL_FACTORS:
        registry.register(factor)
    return registry


def create_fundamental_registry() -> FactorRegistry:
    """仅创建基本面因子注册表。"""
    registry = FactorRegistry()
    for factor in FUNDAMENTAL_FACTORS:
        registry.register(factor)
    return registry
'''


FILES["tests/test_factors.py"] = '''"""因子计算测试。

重点验证:
1. 因子计算不使用未来数据(前视偏差检测)
2. 因子值在合理范围内
3. 数据不足时返回 None
4. 因子定义的 dependencies 与 warmup_days 合理
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from src.factors.base import FactorBase
from src.factors.fundamental import FUNDAMENTAL_FACTORS
from src.factors.technical import TECHNICAL_FACTORS
from src.lookahead.assertions import assert_point_in_time


def _make_candles(n: int = 100, start_price: float = 10.0, seed: int = 42) -> pd.DataFrame:
    """生成模拟 K 线数据。"""
    np.random.seed(seed)
    dates = pd.date_range("2025-01-01", periods=n, freq="B")
    prices = start_price + np.cumsum(np.random.randn(n) * 0.1)
    df = pd.DataFrame({
        "tradeDate": dates.strftime("%Y-%m-%d"),
        "open": prices + np.random.randn(n) * 0.05,
        "high": prices + np.abs(np.random.randn(n)) * 0.1,
        "low": prices - np.abs(np.random.randn(n)) * 0.1,
        "close": prices,
        "volume": np.random.randint(100000, 1000000, n).astype(float),
        "amount": np.random.randint(1000000, 10000000, n).astype(float),
        "peTtm": 10 + np.random.rand(n) * 20,
        "pb": 1 + np.random.rand(n) * 3,
        "psTtm": 1 + np.random.rand(n) * 5,
        "totalMarketCap": 1e9 + np.random.rand(n) * 1e10,
        "floatMarketCap": 5e8 + np.random.rand(n) * 5e9,
        "turnoverRatePct": np.random.rand(n) * 5,
    })
    return df


ALL_FACTORS = TECHNICAL_FACTORS + FUNDAMENTAL_FACTORS


class TestFactorDefinitions:
    """因子定义测试。"""

    def test_all_factors_have_unique_ids(self) -> None:
        ids = [f.definition().id for f in ALL_FACTORS]
        assert len(ids) == len(set(ids)), f"因子 ID 重复: {ids}"

    def test_all_factors_have_valid_direction(self) -> None:
        valid = {"higher-is-better", "lower-is-better", "research"}
        for f in ALL_FACTORS:
            assert f.definition().direction in valid, f"{f.definition().id} 方向无效"

    def test_all_factors_have_warmup_days(self) -> None:
        for f in ALL_FACTORS:
            assert f.definition().warmup_days >= 1, f"{f.definition().id} warmup_days < 1"

    def test_technical_factor_count(self) -> None:
        assert len(TECHNICAL_FACTORS) == 19

    def test_fundamental_factor_count(self) -> None:
        assert len(FUNDAMENTAL_FACTORS) == 8

    def test_total_factor_count(self) -> None:
        assert len(ALL_FACTORS) == 27


class TestNoLookaheadBias:
    """前视偏差测试(铁律)。

    核心思路:在 signal_date 计算因子值,然后修改 signal_date 之后的数据,
    因子值应该不变。
    """

    def test_all_factors_no_lookahead(self) -> None:
        candles = _make_candles(100)
        signal_date = candles["tradeDate"].iloc[70]
        # 计算原始因子值
        original_values: dict[str, float | None] = {}
        for factor in ALL_FACTORS:
            result = factor.compute(candles, signal_date)
            original_values[factor.definition().id] = result.factor_value
        # 修改 signal_date 之后的数据
        modified = candles.copy()
        future_mask = modified["tradeDate"] > signal_date
        modified.loc[future_mask, "close"] *= 2.0
        modified.loc[future_mask, "volume"] *= 3.0
        modified.loc[future_mask, "high"] *= 1.5
        # 重新计算,因子值应该不变
        for factor in ALL_FACTORS:
            result = factor.compute(modified, signal_date)
            orig = original_values[factor.definition().id]
            if orig is None:
                assert result.factor_value is None, (
                    f"{factor.definition().id}: 原本为 None,修改后变为 {result.factor_value}"
                )
            else:
                assert result.factor_value is not None, (
                    f"{factor.definition().id}: 原本 {orig},修改后变为 None"
                )
                assert abs(result.factor_value - orig) < 1e-9, (
                    f"{factor.definition().id}: 原本 {orig},修改后 {result.factor_value},存在前视偏差"
                )


class TestTechnicalFactors:
    """技术因子计算测试。"""

    def test_ma60_slope_with_sufficient_data(self) -> None:
        candles = _make_candles(70)
        factor = TECHNICAL_FACTORS[0]  # Ma60SlopeFactor
        result = factor.compute(candles, candles["tradeDate"].iloc[-1])
        assert result.factor_value is not None
        assert isinstance(result.factor_value, float)

    def test_ma60_slope_insufficient_data(self) -> None:
        candles = _make_candles(60)
        factor = TECHNICAL_FACTORS[0]
        result = factor.compute(candles, candles["tradeDate"].iloc[-1])
        assert result.factor_value is None

    def test_return_10d(self) -> None:
        candles = _make_candles(15)
        factor = next(f for f in TECHNICAL_FACTORS if f.definition().id == "return_10d")
        result = factor.compute(candles, candles["tradeDate"].iloc[-1])
        assert result.factor_value is not None
        closes = candles["close"].values
        expected = closes[-1] / closes[-11] - 1
        assert abs(result.factor_value - expected) < 1e-9

    def test_rsi14_range(self) -> None:
        candles = _make_candles(30)
        factor = next(f for f in TECHNICAL_FACTORS if f.definition().id == "rsi_14")
        result = factor.compute(candles, candles["tradeDate"].iloc[-1])
        assert result.factor_value is not None
        assert 0 <= result.factor_value <= 100

    def test_drawdown_is_negative(self) -> None:
        candles = _make_candles(25)
        factor = next(f for f in TECHNICAL_FACTORS if f.definition().id == "drawdown_20d")
        result = factor.compute(candles, candles["tradeDate"].iloc[-1])
        assert result.factor_value is not None
        assert result.factor_value <= 0


class TestFundamentalFactors:
    """基本面因子计算测试。"""

    def test_pe_ttm(self) -> None:
        candles = _make_candles(5)
        factor = next(f for f in FUNDAMENTAL_FACTORS if f.definition().id == "pe_ttm")
        result = factor.compute(candles, candles["tradeDate"].iloc[-1])
        assert result.factor_value is not None
        assert result.factor_value > 0

    def test_log_market_cap(self) -> None:
        candles = _make_candles(5)
        factor = next(f for f in FUNDAMENTAL_FACTORS if f.definition().id == "log_market_cap")
        result = factor.compute(candles, candles["tradeDate"].iloc[-1])
        assert result.factor_value is not None
        assert result.factor_value > 0  # ln(1e9) > 0

    def test_pe_change_5d(self) -> None:
        candles = _make_candles(10)
        factor = next(f for f in FUNDAMENTAL_FACTORS if f.definition().id == "pe_change_5d")
        result = factor.compute(candles, candles["tradeDate"].iloc[-1])
        assert result.factor_value is not None

    def test_missing_pe_returns_none(self) -> None:
        candles = _make_candles(5).drop(columns=["peTtm"])
        factor = next(f for f in FUNDAMENTAL_FACTORS if f.definition().id == "pe_ttm")
        result = factor.compute(candles, candles["tradeDate"].iloc[-1])
        assert result.factor_value is None


class TestFactorRegistry:
    """因子注册表测试。"""

    def test_default_registry_has_all_factors(self) -> None:
        from src.factors.registry import create_default_registry
        registry = create_default_registry()
        assert len(registry) == 27

    def test_technical_registry(self) -> None:
        from src.factors.registry import create_technical_registry
        registry = create_technical_registry()
        assert len(registry) == 19

    def test_fundamental_registry(self) -> None:
        from src.factors.registry import create_fundamental_registry
        registry = create_fundamental_registry()
        assert len(registry) == 8

    def test_duplicate_registration_raises(self) -> None:
        from src.factors.base import FactorRegistry
        registry = FactorRegistry()
        registry.register(TECHNICAL_FACTORS[0])
        with pytest.raises(ValueError, match="已注册"):
            registry.register(TECHNICAL_FACTORS[0])
'''


def main() -> int:
    print(f"目标目录: {ROOT}")
    print(f"待生成文件数: {len(FILES)}")
    print("-" * 60)
    created = 0
    for rel_path, content in FILES.items():
        full_path = ROOT / rel_path
        full_path.parent.mkdir(parents=True, exist_ok=True)
        if full_path.exists():
            print(f"OVERWRITE: {full_path}")
        else:
            print(f"CREATE: {full_path}")
        full_path.write_text(content, encoding="utf-8")
        created += 1
    print("-" * 60)
    print(f"完成: {created} 个文件")
    return 0


if __name__ == "__main__":
    sys.exit(main())
