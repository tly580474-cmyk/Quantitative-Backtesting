"""成长型风格专属因子(1 个)。

供"成长型(稳中求进)"风格使用,核心理念:用长期动量代理成长性。

因子清单:
- momentum_60d: 60 日动量(close / close_60d_ago - 1)

注:理想的成长型因子应包含营收增速、净利润增速、ROE 变化等,
但当前 DuckDB 快照不含这些字段,只能用价格层面的长期动量作为代理。
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


class Momentum60dFactor(FactorBase):
    """60 日动量。

    close / close_60d_ago - 1,反映近 3 个月的累计涨跌幅。
    长期动量可作为成长性的价格层面代理(业绩驱动 vs 估值抬升无法区分,
    需结合基本面数据,但当前快照不含)。
    """

    def definition(self) -> FactorDefinition:
        return FactorDefinition(
            id="momentum_60d",
            name="60日动量",
            description="近 60 个交易日收益率,作为成长性代理",
            direction=FactorDirection.HIGHER_IS_BETTER,
            dependencies=("close",),
            warmup_days=61,
            tags=("growth", "momentum"),
        )

    def compute(self, candles: pd.DataFrame, signal_date: str) -> FactorComputeResult:
        df = _candles_up_to(candles, signal_date)
        assert_point_in_time(df, signal_date)
        if len(df) < 61:
            return FactorComputeResult(None, f"need 61 bars, got {len(df)}", {})
        closes = df["close"].values.astype(float)
        start = float(closes[-61])
        end = float(closes[-1])
        if start <= 0:
            return FactorComputeResult(None, "start price <= 0", {})
        ret = end / start - 1.0
        return FactorComputeResult(
            float(ret),
            f"close[-61]={start:.2f}, close[-1]={end:.2f}, ret={ret:.4f}",
            {"start": start, "end": end},
        )


# 因子列表(供注册表使用)
GROWTH_FACTORS: list[FactorBase] = [
    Momentum60dFactor(),
]
