"""中性化算子（M2）单元测试。

覆盖：
  * cs_neutralize：剔除对控制变量的线性暴露（规模中性）
  * cs_indneutral：行业内去均值（行业中性），needs_panel 注入面板
  * log_mktcap 终端在合成面板中存在
  * 通过公式树求值的中性化表达式可正常求值
"""
from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from factor_miner.primitives.functions import _cs_indneutral, _cs_neutralize
from factor_miner.tree.serialize import from_prefix
from factor_miner.engine.evaluator import evaluate_tree


def _mini_panel(syms, dates, values, industry_map):
    idx = pd.MultiIndex.from_product([syms, dates])
    f = pd.Series(values, index=idx)
    panel = pd.DataFrame(
        {"industry": [industry_map[s] for s in syms] * len(dates)}, index=idx)
    return f, panel


def test_cs_neutralize_removes_exposure():
    rng = np.random.default_rng(0)
    syms = [f"S{i}" for i in range(8)]
    dates = pd.date_range("2020-01-01", periods=5, freq="B")
    idx = pd.MultiIndex.from_product([syms, dates])
    n = len(idx)
    x = pd.Series(rng.normal(0, 1, n), index=idx)
    y = 2.0 * x + pd.Series(rng.normal(0, 0.05, n), index=idx)
    resid = _cs_neutralize(y, x)
    cors = []
    for d in dates:
        r = resid.xs(d, level=1)
        xx = x.xs(d, level=1)
        if r.std() > 1e-9 and xx.std() > 1e-9:
            cors.append(r.corr(xx))
    # 中性化后，残差与 x 的截面相关应逼近 0
    assert abs(np.mean(cors)) < 0.05


def test_cs_indneutral_demeans_within_industry():
    syms = ["A", "B", "C", "D"]
    ind_map = {"A": "IND1", "B": "IND2", "C": "IND1", "D": "IND2"}
    dates = pd.date_range("2020-01-01", periods=3, freq="B")
    f, panel = _mini_panel(syms, dates, [1.0, 2.0, 3.0, 4.0] * 3, ind_map)
    resid = _cs_indneutral(f, panel)
    grp_mean = resid.groupby(
        [panel["industry"], resid.index.get_level_values(1)]).mean()
    assert grp_mean.abs().max() < 1e-9


def test_cs_indneutral_fallback_without_panel():
    syms = ["A", "B", "C", "D"]
    dates = pd.date_range("2020-01-01", periods=3, freq="B")
    idx = pd.MultiIndex.from_product([syms, dates])
    f = pd.Series([1.0, 2.0, 3.0, 4.0] * 3, index=idx)
    # panel=None → 退化为普通横截面去均值
    resid = _cs_indneutral(f, None)
    daily_mean = resid.groupby(level=1).mean()
    assert daily_mean.abs().max() < 1e-9


def test_log_mktcap_present_in_synthetic(panels):
    assert "log_mktcap" in panels["train"].columns
    assert panels["train"]["log_mktcap"].notna().all()


def test_cs_indneutral_evaluates_on_panel(panels):
    node = from_prefix("(cs_indneutral (inv amount))")
    out = evaluate_tree(node, panels["train"])
    assert isinstance(out, pd.Series)
    assert out.notna().any()


def test_cs_neutralize_roundtrip(panels):
    node = from_prefix("(cs_neutralize (inv amount) log_mktcap)")
    out = evaluate_tree(node, panels["train"])
    assert isinstance(out, pd.Series)
    assert out.notna().any()


def test_combined_neutralize_expression(panels):
    # 规模中性后再做行业中性：应可正常求值且基本非平凡
    node = from_prefix("(cs_indneutral (cs_neutralize (inv amount) log_mktcap))")
    out = evaluate_tree(node, panels["train"])
    assert isinstance(out, pd.Series)
    assert out.notna().any()
    assert out.std() > 0
