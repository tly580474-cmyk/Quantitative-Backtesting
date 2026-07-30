"""Daily cross-sectional preprocessing shared by mined factors."""
from __future__ import annotations

import numpy as np
import pandas as pd


def preprocess_factor(values: pd.Series, panel: pd.DataFrame,
                      market_cap_neutral: bool = True) -> pd.Series:
    frame = pd.DataFrame({"value": values}, index=panel.index)
    frame["date"] = frame.index.get_level_values(1)
    frame["industry"] = panel.get("industry", pd.Series("UNKNOWN", index=panel.index))
    frame["size"] = np.log(panel.get(
        "market_cap", pd.Series(np.nan, index=panel.index)).clip(lower=1.0))

    def transform(day: pd.DataFrame) -> pd.Series:
        value = day["value"].astype(float)
        valid = value.dropna()
        if len(valid) < 3:
            return value * np.nan
        lo, hi = valid.quantile([0.01, 0.99])
        value = value.clip(lo, hi)
        std = value.std()
        value = (value - value.mean()) / std if std and np.isfinite(std) else value * np.nan
        value = value - value.groupby(day["industry"].fillna("UNKNOWN")).transform("mean")
        if market_cap_neutral:
            pair = pd.concat([value.rename("y"), day["size"].rename("x")], axis=1).dropna()
            if len(pair) >= 3 and pair["x"].var() > 1e-12:
                beta = pair["y"].cov(pair["x"]) / pair["x"].var()
                value.loc[pair.index] = pair["y"] - beta * (pair["x"] - pair["x"].mean())
        return value

    pieces = [transform(day) for _, day in frame.groupby("date", sort=False)]
    return pd.concat(pieces).reindex(panel.index)
