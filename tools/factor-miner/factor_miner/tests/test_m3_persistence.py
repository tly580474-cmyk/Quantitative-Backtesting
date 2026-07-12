"""M3-3 本地因子库持久化单元测试。"""
from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from factor_miner.persistence import FactorLibrary


def _mk_factor(prefix="(ts_mean returns 5)", passed=True):
    idx = pd.MultiIndex.from_product(
        [["S0", "S1"], pd.date_range("2020-01-01", periods=3)],
        names=["symbol", "date"],
    )
    fac = pd.Series(np.linspace(-1, 1, len(idx)), index=idx, name="v")
    return {
        "formula": "ts_mean(returns, 5)", "prefix": prefix,
        "train_rankic": 0.5, "test_rankic": 0.48, "train_icir": 3.0,
        "test_icir": 2.8, "test_ic_t": 50.0, "ls_sharpe": 2.0, "mdd": -0.2,
        "oos_decay": 0.1, "mi_test": 0.3, "top_mean_ret": 0.01,
        "bottom_mean_ret": -0.01, "corr_max": 0.3, "rolling_mean": 0.47,
        "rolling_min": 0.45, "test_rankic_by_window": {5: 0.48},
        "passed": passed, "factor": fac,
    }


def test_add_and_query(tmp_path):
    lib = FactorLibrary(str(tmp_path / "lib"), version="v1")
    fid = lib.add_factor(_mk_factor(), run_id="r1")
    assert fid is not None and fid >= 1
    df = lib.query()
    assert len(df) == 1
    assert df.iloc[0]["prefix"] == "(ts_mean returns 5)"
    assert df.iloc[0]["passed"] == 1
    # 取值 roundtrip
    vals = lib.get_factor_values(fid)
    assert vals is not None and len(vals) == 6
    assert np.allclose(vals.to_numpy(), np.linspace(-1, 1, 6))


def test_dedup_skips_duplicate(tmp_path):
    lib = FactorLibrary(str(tmp_path / "lib"), version="v1")
    fid1 = lib.add_factor(_mk_factor(), run_id="r1")
    fid2 = lib.add_factor(_mk_factor(), run_id="r2")  # 同 prefix
    assert fid1 is not None
    assert fid2 is None
    assert len(lib.query()) == 1
    assert lib.summary()["total"] == 1


def test_trace_persisted(tmp_path):
    lib = FactorLibrary(str(tmp_path / "lib"), version="v1")
    trace = [{"generation": 0, "best_train_fitness": 1.0}]
    path = lib.add_trace(trace, run_id="r1")
    import os
    assert os.path.exists(path)
    import json
    with open(path, "r", encoding="utf-8") as f:
        assert json.load(f)[0]["generation"] == 0


def test_passed_filter(tmp_path):
    lib = FactorLibrary(str(tmp_path / "lib"), version="v1")
    lib.add_factor(_mk_factor(passed=True), run_id="r1")
    lib.add_factor(_mk_factor(prefix="(inv amount)", passed=False), run_id="r1")
    assert len(lib.query()) == 2
    assert len(lib.query(passed_only=True)) == 1


def test_summary_counts(tmp_path):
    lib = FactorLibrary(str(tmp_path / "lib"), version="v1")
    lib.add_factor(_mk_factor(passed=True), run_id="r1")
    lib.add_factor(_mk_factor(prefix="(inv amount)", passed=False), run_id="r1")
    s = lib.summary()
    assert s["total"] == 2 and s["passed"] == 1 and s["version"] == "v1"
