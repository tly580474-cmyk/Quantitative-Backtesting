from __future__ import annotations

import numpy as np
import pandas as pd

from factor_miner.analysis.multiple_testing import deflated_sharpe_probability


def test_more_formula_trials_reduce_deflated_sharpe_probability():
    rng = np.random.default_rng(7)
    returns = pd.Series(rng.normal(0.01, 0.02, 80))
    one = deflated_sharpe_probability(returns, 3.0, 252 / 5, 1)
    many = deflated_sharpe_probability(returns, 3.0, 252 / 5, 1000)
    assert 0 <= many < one <= 1


def test_deflated_sharpe_rejects_insufficient_samples():
    value = deflated_sharpe_probability(pd.Series([0.1, 0.2]), 1.0, 252, 10)
    assert np.isnan(value)
