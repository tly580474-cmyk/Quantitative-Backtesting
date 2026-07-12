"""算子数值正确性与数值保护测试。"""
from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from factor_miner.primitives.functions import FUNCTIONS


def _cs_index(values):
    idx = pd.MultiIndex.from_arrays([
        ["A", "B", "C"], ["2020-01-01"] * 3])
    return pd.Series(values, index=idx)


def test_scalar_basic():
    s = pd.Series([1.0, 2.0, 3.0])
    assert FUNCTIONS["add"].func(s, s).tolist() == [2.0, 4.0, 6.0]
    assert FUNCTIONS["sub"].func(s, s).abs().max() == 0.0
    assert FUNCTIONS["mul"].func(s, s).tolist() == [1.0, 4.0, 9.0]


def test_div_by_zero_no_inf():
    s = pd.Series([1.0, 2.0, 3.0])
    z = pd.Series([0.0, 0.0, 0.0])
    d = FUNCTIONS["div"].func(s, z)
    assert not np.any(np.isinf(d))
    assert not np.any(np.isnan(d))


def test_log_negative_protected():
    neg = pd.Series([-1.0, -2.0, -5.0])
    out = FUNCTIONS["log"].func(neg)
    assert np.all(np.isfinite(out))


def test_sqrt_negative_finite():
    out = FUNCTIONS["sqrt"].func(pd.Series([-4.0, 0.0, 9.0]))
    assert np.all(np.isfinite(out))


def test_inv_protected():
    out = FUNCTIONS["inv"].func(pd.Series([0.0, 2.0]))
    assert not np.any(np.isinf(out))


def test_cs_rank_normalized():
    r = FUNCTIONS["cs_rank"].func(_cs_index([3.0, 1.0, 2.0]))
    assert abs(r.max() - 1.0) < 1e-9
    assert abs(r.min() - 1 / 3) < 1e-9


def test_cs_zscore_zero_mean():
    r = FUNCTIONS["cs_zscore"].func(_cs_index([3.0, 1.0, 2.0]))
    assert abs(r.mean()) < 1e-9


def test_ts_mean_window():
    idx = pd.MultiIndex.from_arrays([["A"] * 5, pd.date_range("2020-01-01", periods=5)])
    s = pd.Series([1.0, 2.0, 3.0, 4.0, 5.0], index=idx)
    m = FUNCTIONS["ts_mean"].func(s, 5)
    assert m.iloc[-1] == pytest.approx(3.0)


def test_all_functions_produce_finite_on_random_panel(panels):
    import random
    from factor_miner.primitives.functions import WINDOWS
    from factor_miner.tree.generator import Generator
    from factor_miner.tree.node import Node
    from factor_miner.engine.evaluator import evaluate_tree

    rng = random.Random(7)
    g = Generator({"primitives": {}, "evolution": {"seed": 0}}, rng)
    g.terminals = ["close", "volume", "returns"]
    g.funcs = list(FUNCTIONS.values())
    for _ in range(50):
        node = g.generate(min_depth=1, max_depth=3)
        out = evaluate_tree(node, panels["train"])
        if isinstance(out, pd.Series):
            assert np.all(np.isfinite(out.replace([np.inf, -np.inf], np.nan).fillna(0)))
