import numpy as np
import pandas as pd

from factor_miner.fitness.preprocessing import preprocess_factor


def test_daily_preprocessing_clips_standardizes_and_neutralizes():
    index = pd.MultiIndex.from_product(
        [["A", "B", "C", "D", "E", "F"], pd.to_datetime(["2026-01-05"])],
        names=["symbol", "trade_date"])
    panel = pd.DataFrame({
        "industry": ["I1", "I1", "I1", "I2", "I2", "I2"],
        "market_cap": [1e9, 2e9, 3e9, 1e9, 2e9, 3e9],
    }, index=index)
    values = pd.Series([1, 2, 1000, 2, 3, 4], index=index, dtype=float)
    result = preprocess_factor(values, panel)
    assert result.notna().all()
    assert abs(result.groupby(level=1).mean().iloc[0]) < 1e-9
    assert abs(result.corr(np.log(panel["market_cap"]))) < 1e-8
