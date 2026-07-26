"""风格专属因子的向量化实现。

为 8 个新增 K 线衍生因子提供 pandas 向量化计算,函数签名与现有
vectorized.py 保持一致,语义严格对齐 compute() 实现(避免重蹈
vectorized.py 与 technical.py 不一致的覆辙)。

设计要点:
1. 按 instrumentKey 分组,对每只股票独立计算
2. 用 pandas rolling/shift/ewm 实现向量化
3. 严格无前视偏差(rolling 窗口默认 min_periods=period,shift 不含未来数据)
4. pivot 为宽表(index=tradeDate, columns=instrumentKey)
"""

from __future__ import annotations

import numpy as np
import pandas as pd

# 主板涨停阈值(与 shortterm.py 保持一致)
LIMIT_UP_THRESHOLD = 0.095


def _compute_factor_series_for_instrument(factor_id: str, g: pd.DataFrame) -> pd.Series:
    """对单只股票计算因子序列,返回与 g.index 对齐的 Series。

    严格无前视偏差: 所有 rolling/shift 都不使用未来数据。
    """
    g = g.sort_values("tradeDate").reset_index(drop=True)
    n = len(g)
    if n == 0:
        return pd.Series(dtype=float)

    close = g["close"].astype(float)
    high = g["high"].astype(float)
    low = g["low"].astype(float)
    open_ = g["open"].astype(float) if "open" in g else None

    if factor_id == "atr_20":
        # TR = max(H-L, |H-prev_close|, |L-prev_close|)
        prev_close = close.shift(1)
        tr1 = high - low
        tr2 = (high - prev_close).abs()
        tr3 = (low - prev_close).abs()
        tr = pd.concat([tr1, tr2, tr3], axis=1).max(axis=1)
        # 第一行 prev_close 为 NaN, tr2/tr3 为 NaN, 退化为 tr1
        atr = tr.rolling(20, min_periods=20).mean()
        # 标准化为 atr / close
        result = atr / close.replace(0, np.nan)
        return result

    if factor_id == "turtle_breakout_20":
        # 前 20 日(不含当日)的 high 最大值
        # shift(1) 取前一日的 20 日 rolling max = 过去 20 日(不含当日)
        high_20d_prev = high.shift(1).rolling(20, min_periods=20).max()
        strength = (close - high_20d_prev) / high_20d_prev.replace(0, np.nan)
        return strength

    if factor_id == "ma_alignment_strength":
        ma5 = close.rolling(5, min_periods=5).mean()
        ma10 = close.rolling(10, min_periods=10).mean()
        ma20 = close.rolling(20, min_periods=20).mean()
        ma60 = close.rolling(60, min_periods=60).mean()

        def _comp(ma_short, ma_long, weight):
            sign = np.where(ma_short > ma_long, 1.0, -1.0)
            dist = (ma_short - ma_long) / ma_long.replace(0, np.nan)
            return weight * sign * dist

        result = (
            _comp(ma5, ma10, 0.4)
            + _comp(ma10, ma20, 0.3)
            + _comp(ma20, ma60, 0.3)
        )
        # 前 60 行 ma60 为 NaN, 结果为 NaN
        return pd.Series(result, index=g.index)

    if factor_id == "limit_up_consecutive":
        # 每日涨幅
        ret = close.pct_change()  # close.shift(0)/close.shift(1) - 1
        # 是否涨停(>= 9.5%)
        is_limit = (ret >= LIMIT_UP_THRESHOLD).astype(int)
        # 从最近一日向前数连续涨停天数
        # 用累计技巧: 反向 cumsum,遇到 0 重置
        # 实现: 从后向前数连续 1 的个数
        # 简化: 用循环或 cumsum trick
        # trick: 在每个位置计算"以该位置结尾的最长连续 1 子串长度"
        # 用 cs = is_limit.cumsum(); reset at 0: counter = cs - cs.where(is_limit==0).ffill().fillna(0)
        cs = is_limit.cumsum()
        # 找最近的 0 的 cumsum 值
        last_zero_cs = cs.where(is_limit == 0).ffill().fillna(0)
        consecutive = cs - last_zero_cs
        return consecutive.astype(float)

    if factor_id == "kdj_j":
        # 9 日 RSV
        low_9 = low.rolling(9, min_periods=9).min()
        high_9 = high.rolling(9, min_periods=9).max()
        rsv = (close - low_9) / (high_9 - low_9).replace(0, np.nan) * 100.0
        rsv = rsv.fillna(50.0)  # 与 compute() 默认 50 一致
        # K = SMA(RSV, 3, 1) = EMA with alpha=1/3
        k = rsv.ewm(alpha=1 / 3, adjust=False, min_periods=1).mean()
        # 初始 K=50, ewm adjust=False 第一期为 rsv[0], 但我们设 rsv 缺失时为 50
        # 为对齐 compute() 初始 K=50, 这里手动调整:前 8 个交易日 RSV 缺失, K 应为 50
        k = k.where(rsv.index < 9, k)  # 占位,实际下方修正
        # 修正: 前 8 个交易日 RSV 缺失, K 应保持 50
        # 但 rsv 已经 fillna(50), ewm 会从第一期开始计算, 导致 K 与 compute 不一致
        # 改进: 让 rsv 前 8 期为 NaN, ewm 自动从第 9 期开始, 但 K 初始为 50
        rsv_raw = (close - low_9) / (high_9 - low_9).replace(0, np.nan) * 100.0
        k_raw = rsv_raw.ewm(alpha=1 / 3, adjust=False, min_periods=1).mean()
        # 前 8 期 rsv_raw 为 NaN, ewm 输出 NaN, 填充为 50
        k = k_raw.fillna(50.0)
        d = k.ewm(alpha=1 / 3, adjust=False, min_periods=1).mean()
        d = d.fillna(50.0)
        j = 3 * k - 2 * d
        return j

    if factor_id == "bias_6":
        ma6 = close.rolling(6, min_periods=6).mean()
        bias = (close - ma6) / ma6.replace(0, np.nan)
        return bias

    if factor_id == "momentum_60d":
        # close / close_60d_ago - 1
        ret_60d = close.pct_change(periods=60)
        return ret_60d

    if factor_id == "intraday_strength":
        if open_ is None:
            return pd.Series(np.nan, index=g.index)
        hl_range = (high - low).replace(0, np.nan)
        strength = (close - open_) / hl_range
        # clip [-1, 1], 一字板 hl_range=0 → NaN → 填 0
        strength = strength.clip(-1.0, 1.0).fillna(0.0)
        return strength

    raise ValueError(f"未知的风格专属因子: {factor_id}")


def build_style_factor_panel_vectorized(
    factor_id: str,
    candles_long: pd.DataFrame,
) -> pd.DataFrame:
    """构造单个风格专属因子的面板(宽表)。

    Args:
        factor_id: 因子 ID(必须属于 8 个风格专属因子之一)
        candles_long: 长表(instrumentKey, tradeDate, open, high, low, close, ...)

    Returns:
        宽表 DataFrame(index=tradeDate, columns=instrumentKey)
    """
    if candles_long.empty:
        return pd.DataFrame()

    df = candles_long.sort_values(["instrumentKey", "tradeDate"]).reset_index(drop=True).copy()

    # 对每只股票独立计算, 然后拼接(避免 groupby.apply 索引混乱)
    parts: list[pd.Series] = []
    for inst_key, g in df.groupby("instrumentKey", sort=False):
        result = _compute_factor_series_for_instrument(factor_id, g)
        result = pd.Series(result.values, index=g.index)
        parts.append(result)

    if not parts:
        return pd.DataFrame()

    df["value"] = pd.concat(parts)

    # 转为宽表
    panel = df.pivot(index="tradeDate", columns="instrumentKey", values="value")
    panel = panel.sort_index()
    return panel


def build_all_style_factor_panels_vectorized(
    candles_long: pd.DataFrame,
    factor_ids: list[str] | None = None,
) -> dict[str, pd.DataFrame]:
    """构造所有风格专属因子的面板。

    Args:
        candles_long: 长表
        factor_ids: 因子 ID 列表,None 则使用全部 8 个

    Returns:
        {factor_id: panel} 字典
    """
    if factor_ids is None:
        factor_ids = [
            "atr_20",
            "turtle_breakout_20",
            "ma_alignment_strength",
            "limit_up_consecutive",
            "kdj_j",
            "bias_6",
            "momentum_60d",
            "intraday_strength",
        ]

    panels: dict[str, pd.DataFrame] = {}
    for fid in factor_ids:
        try:
            panel = build_style_factor_panel_vectorized(fid, candles_long)
            panels[fid] = panel
        except Exception as e:
            print(f"警告: 构造因子 {fid} 面板失败: {e}")
            panels[fid] = pd.DataFrame()
    return panels


__all__ = [
    "build_style_factor_panel_vectorized",
    "build_all_style_factor_panels_vectorized",
    "_compute_factor_series_for_instrument",
]
