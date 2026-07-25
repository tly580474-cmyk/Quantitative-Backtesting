"""重写 vectorized.py: 用更稳定的拼接方式替代 groupby.apply。

旧方式: groupby.apply 返回 Series, 但 pandas 2.0+ 行为改变, 索引混乱。
新方式: for 循环遍历每只股票, 用 concat 拼接, 不依赖 apply 的索引语义。
"""
from pathlib import Path

TARGET = Path(r"D:\github_public_repo\评分规则探索\src\panel\vectorized.py")
content = TARGET.read_text(encoding="utf-8")

# 替换 build_factor_panel_vectorized 函数
old = '''def build_factor_panel_vectorized(
    factor_id: str,
    candles_long: pd.DataFrame,
) -> pd.DataFrame:
    """向量化构造单因子面板。

    Args:
        factor_id: 因子 ID
        candles_long: K 线长表, 必须含 instrumentKey/tradeDate 与因子依赖字段

    Returns:
        DataFrame, index=tradeDate(升序), columns=instrumentKey, values=因子值
    """
    if candles_long.empty:
        return pd.DataFrame()

    df = candles_long.sort_values(["instrumentKey", "tradeDate"]).copy()

    # 按 instrumentKey 分组, 每组计算因子序列
    def _compute_for_group(g: pd.DataFrame) -> pd.Series:
        """对一只股票的 K 线计算因子序列, 返回 Series(index=tradeDate, values=factor_value)。"""
        close = g["close"]
        open_ = g["open"]
        high = g["high"]
        low = g["low"]
        volume = g["volume"]
        idx = g["tradeDate"]

        if factor_id == "ma60_slope_5d":
            ma60 = close.rolling(60, min_periods=60).mean()
            result = (ma60 - ma60.shift(5)) / ma60.shift(5).replace(0, np.nan)
        elif factor_id == "ma20_above_ma60":
            ma20 = close.rolling(20, min_periods=20).mean()
            ma60 = close.rolling(60, min_periods=60).mean()
            result = ma20 - ma60
        elif factor_id == "price_above_ma20":
            ma20 = close.rolling(20, min_periods=20).mean()
            result = (close - ma20) / ma20.replace(0, np.nan)
        elif factor_id == "short_ma_slope":
            ma10 = close.rolling(10, min_periods=10).mean()
            result = (ma10 - ma10.shift(1)) / ma10.shift(1).replace(0, np.nan)
        elif factor_id == "return_10d":
            result = close.pct_change(periods=10)
        elif factor_id == "return_20d":
            result = close.pct_change(periods=20)
        elif factor_id == "distance_to_20d_high":
            past_high = high.rolling(20, min_periods=20).max()
            result = (close - past_high) / past_high.replace(0, np.nan)
        elif factor_id == "consecutive_down_days":
            result = _group_consecutive_down_days(close)
        elif factor_id == "volume_ratio":
            avg_vol = volume.rolling(20, min_periods=20).mean()
            result = volume / avg_vol.replace(0, np.nan)
        elif factor_id == "up_vs_down_volume":
            result = _group_up_vs_down_volume(close, volume, window=10)
        elif factor_id == "amount_20d_avg":
            amount = g["amount"] if "amount" in g.columns else volume * close
            result = amount.rolling(20, min_periods=20).mean()
        elif factor_id == "breakout_20d":
            result = _group_breakout_20d(close, high, window=20)
        elif factor_id == "higher_lows":
            result = _group_higher_lows(low, window=10)
        elif factor_id == "contraction":
            past_high = high.rolling(20, min_periods=20).max()
            past_low = low.rolling(20, min_periods=20).min()
            result = (past_high - past_low) / past_low.replace(0, np.nan)
        elif factor_id == "bullish_candle_ratio":
            result = _group_bullish_candle_ratio(open_, close, window=10)
        elif factor_id == "macd_histogram":
            result = _group_macd_histogram(close)
        elif factor_id == "rsi_14":
            result = _group_wilder_rsi(close, period=14)
        elif factor_id == "drawdown_20d":
            result = _group_max_drawdown(close, window=20)
        elif factor_id == "consecutive_large_bearish":
            result = _group_consecutive_large_bearish(close, threshold=-0.03)
        # 基本面因子(直接读取)
        elif factor_id == "pe_ttm":
            result = g["pe_ttm"]
        elif factor_id == "pb":
            result = g["pb"]
        elif factor_id == "ps_ttm":
            result = g["ps_ttm"]
        elif factor_id == "log_market_cap":
            result = np.log(g["market_cap"].replace(0, np.nan))
        elif factor_id == "turnover_rate":
            result = g["turnover_rate"]
        elif factor_id == "dividend_yield":
            # 无 dividend_yield 列, 全 NaN
            result = pd.Series(np.nan, index=idx)
        elif factor_id == "pe_change_5d":
            result = g["pe_ttm"].pct_change(periods=5)
        elif factor_id == "log_float_market_cap":
            result = np.log(g["float_market_cap"].replace(0, np.nan))
        else:
            raise ValueError(f"未实现向量化版本的因子: {factor_id}")

        result.index = idx
        return result

    series_per_inst = df.groupby("instrumentKey", sort=False, group_keys=False).apply(_compute_for_group)

    # 转为宽表
    if isinstance(series_per_inst, pd.Series):
        # index 是 MultiIndex (instrumentKey, tradeDate)? 不一定
        # 用 groupby + apply 时, 返回 Series 的 index 是原 df 的 index
        # 需要重新组织: 用 tradeDate 作为 index, instrumentKey 作为 columns
        df_with_factor = df[["instrumentKey", "tradeDate"]].copy()
        df_with_factor["value"] = series_per_inst.values
        panel = df_with_factor.pivot(index="tradeDate", columns="instrumentKey", values="value")
    else:
        panel = pd.DataFrame()

    if not panel.empty:
        panel = panel.sort_index()
    return panel'''


new = '''def _compute_factor_series_for_instrument(
    factor_id: str,
    g: pd.DataFrame,
) -> pd.Series:
    """对一只股票的 K 线计算因子序列。

    返回 Series(index=原 df index, values=factor_value)。
    注意: 不重设 index, 让调用方决定如何处理。
    """
    close = g["close"]
    open_ = g["open"]
    high = g["high"]
    low = g["low"]
    volume = g["volume"]

    if factor_id == "ma60_slope_5d":
        ma60 = close.rolling(60, min_periods=60).mean()
        result = (ma60 - ma60.shift(5)) / ma60.shift(5).replace(0, np.nan)
    elif factor_id == "ma20_above_ma60":
        ma20 = close.rolling(20, min_periods=20).mean()
        ma60 = close.rolling(60, min_periods=60).mean()
        result = ma20 - ma60
    elif factor_id == "price_above_ma20":
        ma20 = close.rolling(20, min_periods=20).mean()
        result = (close - ma20) / ma20.replace(0, np.nan)
    elif factor_id == "short_ma_slope":
        ma10 = close.rolling(10, min_periods=10).mean()
        result = (ma10 - ma10.shift(1)) / ma10.shift(1).replace(0, np.nan)
    elif factor_id == "return_10d":
        result = close.pct_change(periods=10)
    elif factor_id == "return_20d":
        result = close.pct_change(periods=20)
    elif factor_id == "distance_to_20d_high":
        past_high = high.rolling(20, min_periods=20).max()
        result = (close - past_high) / past_high.replace(0, np.nan)
    elif factor_id == "consecutive_down_days":
        result = _group_consecutive_down_days(close)
    elif factor_id == "volume_ratio":
        avg_vol = volume.rolling(20, min_periods=20).mean()
        result = volume / avg_vol.replace(0, np.nan)
    elif factor_id == "up_vs_down_volume":
        result = _group_up_vs_down_volume(close, volume, window=10)
    elif factor_id == "amount_20d_avg":
        amount = g["amount"] if "amount" in g.columns else volume * close
        result = amount.rolling(20, min_periods=20).mean()
    elif factor_id == "breakout_20d":
        result = _group_breakout_20d(close, high, window=20)
    elif factor_id == "higher_lows":
        result = _group_higher_lows(low, window=10)
    elif factor_id == "contraction":
        past_high = high.rolling(20, min_periods=20).max()
        past_low = low.rolling(20, min_periods=20).min()
        result = (past_high - past_low) / past_low.replace(0, np.nan)
    elif factor_id == "bullish_candle_ratio":
        result = _group_bullish_candle_ratio(open_, close, window=10)
    elif factor_id == "macd_histogram":
        result = _group_macd_histogram(close)
    elif factor_id == "rsi_14":
        result = _group_wilder_rsi(close, period=14)
    elif factor_id == "drawdown_20d":
        result = _group_max_drawdown(close, window=20)
    elif factor_id == "consecutive_large_bearish":
        result = _group_consecutive_large_bearish(close, threshold=-0.03)
    # 基本面因子(直接读取)
    elif factor_id == "pe_ttm":
        result = g["pe_ttm"]
    elif factor_id == "pb":
        result = g["pb"]
    elif factor_id == "ps_ttm":
        result = g["ps_ttm"]
    elif factor_id == "log_market_cap":
        result = np.log(g["market_cap"].replace(0, np.nan))
    elif factor_id == "turnover_rate":
        result = g["turnover_rate"]
    elif factor_id == "dividend_yield":
        result = pd.Series(np.nan, index=g.index)
    elif factor_id == "pe_change_5d":
        result = g["pe_ttm"].pct_change(periods=5)
    elif factor_id == "log_float_market_cap":
        result = np.log(g["float_market_cap"].replace(0, np.nan))
    else:
        raise ValueError(f"未实现向量化版本的因子: {factor_id}")

    return result


def build_factor_panel_vectorized(
    factor_id: str,
    candles_long: pd.DataFrame,
) -> pd.DataFrame:
    """向量化构造单因子面板。

    Args:
        factor_id: 因子 ID
        candles_long: K 线长表, 必须含 instrumentKey/tradeDate 与因子依赖字段

    Returns:
        DataFrame, index=tradeDate(升序), columns=instrumentKey, values=因子值
    """
    if candles_long.empty:
        return pd.DataFrame()

    df = candles_long.sort_values(["instrumentKey", "tradeDate"]).reset_index(drop=True).copy()

    # 对每只股票单独计算, 用 concat 拼接
    parts: list[pd.Series] = []
    for inst_key, g in df.groupby("instrumentKey", sort=False):
        # 不传 instrumentKey 列给 _compute_factor_series, 避免依赖列问题
        result = _compute_factor_series_for_instrument(factor_id, g)
        # 索引对齐到原 df 的索引
        result = pd.Series(result.values, index=g.index)
        parts.append(result)

    # 拼接所有股票的因子值, index 是原 df 的索引
    if not parts:
        return pd.DataFrame()
    df["value"] = pd.concat(parts)

    # 转为宽表
    panel = df.pivot(index="tradeDate", columns="instrumentKey", values="value")
    panel = panel.sort_index()
    return panel'''

assert old in content, "未找到待替换块"
content = content.replace(old, new, 1)
TARGET.write_text(content, encoding="utf-8")
print("Refactored vectorized.py")
