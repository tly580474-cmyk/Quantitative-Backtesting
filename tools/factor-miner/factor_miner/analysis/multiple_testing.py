"""大规模公式搜索的 Deflated Sharpe Ratio（DSR）校正。"""
from __future__ import annotations

import math
from statistics import NormalDist

import numpy as np
import pandas as pd

EULER_GAMMA = 0.5772156649015329


def deflated_sharpe_probability(returns: pd.Series, annualized_sharpe: float,
                                periods_per_year: float, n_trials: int) -> float:
    """返回观察到的 Sharpe 超过多重试验期望最大 Sharpe 的概率。"""
    clean = pd.Series(returns, dtype="float64").replace([np.inf, -np.inf], np.nan).dropna()
    n = len(clean)
    trials = max(1, int(n_trials))
    if n < 3 or not np.isfinite(annualized_sharpe) or periods_per_year <= 0:
        return float("nan")
    scale = math.sqrt(periods_per_year)
    observed = float(annualized_sharpe) / scale
    normal = NormalDist()
    if trials == 1:
        expected_max = 0.0
    else:
        z1 = normal.inv_cdf(1.0 - 1.0 / trials)
        z2 = normal.inv_cdf(1.0 - 1.0 / (trials * math.e))
        expected_max = ((1.0 - EULER_GAMMA) * z1 + EULER_GAMMA * z2) / math.sqrt(max(1, n - 1))
    skew = float(clean.skew()) if n > 2 else 0.0
    kurtosis = float(clean.kurt() + 3.0) if n > 3 else 3.0
    variance = max(1e-12, 1.0 - skew * observed + (kurtosis - 1.0) * observed ** 2 / 4.0)
    statistic = (observed - expected_max) * math.sqrt(n - 1) / math.sqrt(variance)
    return float(normal.cdf(statistic))
