"""分层回测：按因子横截面分位分组，计算多头/多空组合表现。

使用标签收益（forward return）作为持有期收益。多日标签采用非重叠调仓，
避免把重叠持有期收益误当作独立日收益复利。
输出：多空日收益序列、年化夏普、最大回撤、各组均值收益。
"""
from __future__ import annotations

import logging

import numpy as np
import pandas as pd

logger = logging.getLogger("factor_miner")


def _infer_horizon(fwd: pd.Series, horizon: int | None) -> int:
    if horizon is not None:
        return max(1, int(horizon))
    name = str(getattr(fwd, "name", "") or "")
    try:
        return max(1, int(name.rsplit("_", 1)[-1])) if name.startswith("forward_ret_") else 1
    except ValueError:
        return 1


def layer_backtest(factor: pd.Series, fwd: pd.Series, n_groups: int = 5,
                   horizon: int | None = None, total_cost_bps: float = 0.0) -> dict:
    df = pd.DataFrame({"f": factor, "r": fwd}).dropna()
    if len(df) < 100:
        return {"long_short_sharpe": np.nan, "max_drawdown": np.nan,
                "top_mean_ret": np.nan, "bottom_mean_ret": np.nan,
                "long_short_series": pd.Series(dtype="float64")}
    dates = df.index.get_level_values(1)
    df = df.assign(_date=dates)
    df["group"] = df.groupby("_date")["f"].transform(
        lambda s: pd.qcut(s.rank(method="first"), n_groups, labels=False, duplicates="drop")
    )
    grp = df.groupby(["_date", "group"])["r"].mean().unstack("group")
    if grp.shape[1] < 2:
        return {"long_short_sharpe": np.nan, "max_drawdown": np.nan,
                "top_mean_ret": np.nan, "bottom_mean_ret": np.nan,
                "long_short_series": pd.Series(dtype="float64")}
    bottom, top = grp[0], grp[grp.shape[1] - 1]
    holding_days = _infer_horizon(fwd, horizon)
    # 单一非重叠子组合：每隔 holding_days 个交易日调仓一次。
    # 后续可扩展为多个错位 sleeve，但不能直接复利全部重叠标签。
    gross_long_short = (top - bottom).dropna().iloc[::holding_days]
    # 多空组合每次调仓包含多头和空头各一买一卖，共四条腿成本。
    long_short = gross_long_short - 4.0 * float(total_cost_bps) / 10000.0
    periods_per_year = 252.0 / holding_days
    sharpe = (long_short.mean() / long_short.std() * np.sqrt(periods_per_year)) if long_short.std() > 1e-12 else np.nan
    cum = (1 + long_short).cumprod()
    peak = cum.cummax()
    mdd = float((cum / peak - 1).min()) if len(cum) else np.nan
    return {
        "long_short_sharpe": float(sharpe) if np.isfinite(sharpe) else np.nan,
        "max_drawdown": mdd,
        "top_mean_ret": float(top.mean()) if len(top) else np.nan,
        "bottom_mean_ret": float(bottom.mean()) if len(bottom) else np.nan,
        "long_short_series": long_short,
        "group_returns": grp,
        "holding_days": holding_days,
        "periods_per_year": periods_per_year,
        "portfolio_method": "non_overlapping",
        "total_cost_bps_per_leg": float(total_cost_bps),
    }
