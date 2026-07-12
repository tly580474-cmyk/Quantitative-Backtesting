"""M3 适应度分析优化 · 数值等价性 + 缓存/合并正确性测试。

核心保证：向量化 RankIC（= 因子秩 与 标签秩 的逐日 Pearson）必须与 pandas 原生
逐日 Spearman 严格等价；预计算 label_rank / factor_rank 复用不得改变任何数值。
"""
from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from factor_miner.fitness.metrics import (
    rankic_series, mean_rankic, compute_metrics,
    cross_section_rank, get_label_rank, clear_label_rank_cache,
)
from factor_miner.data.loader import make_synthetic_panel


# ---------------------------------------------------------------------------
# 地面真值：pandas 原生逐日 spearman（原实现语义）
# ---------------------------------------------------------------------------
def _ref_rankic(factor: pd.Series, fwd: pd.Series) -> pd.Series:
    df = pd.DataFrame({"f": factor, "r": fwd})

    def _one(g):
        f = g["f"]
        r = g["r"]
        m = f.notna() & r.notna()
        if m.sum() < 10:
            return np.nan
        fv, rv = f[m], r[m]
        if fv.nunique() < 2 or rv.nunique() < 2:
            return np.nan
        return fv.corr(rv, method="spearman")

    return df.groupby(level=1, group_keys=False).apply(_one)


def _ref_mean_rankic(factor, fwd):
    return float(_ref_rankic(factor, fwd).dropna().mean())


def _make_panel(n_symbols, n_dates, seed, frac_nan=0.05, inject_const=False,
                integer=False):
    rng = np.random.default_rng(seed)
    syms = [f"S{i}" for i in range(n_symbols)]
    dates = pd.date_range("2020-01-01", periods=n_dates, freq="D")
    idx = pd.MultiIndex.from_product([syms, dates], names=["symbol", "date"])
    f = rng.standard_normal(len(idx))
    r = rng.standard_normal(len(idx))
    if integer:  # 制造大量并列（ties），压力测试 rank/tie 处理
        f = np.floor(f * 3)
        r = np.floor(r * 3)
    mask = rng.random(len(idx)) < frac_nan
    f[mask] = np.nan
    r[mask] = np.nan
    if inject_const:  # 若干交易日因子为常量截面
        for d in dates[:3]:
            f[idx.get_level_values(1) == d] = 1.0
    return pd.Series(f, index=idx, name="f"), pd.Series(r, index=idx, name="r")


def assert_series_close(a: pd.Series, b: pd.Series, tol=1e-9):
    both = pd.concat([a.rename("a"), b.rename("b")], axis=1)
    fin = both["a"].notna() & both["b"].notna()
    assert fin.sum() > 0, "无可比对的有限值"
    assert np.allclose(both.loc[fin, "a"].to_numpy(),
                       both.loc[fin, "b"].to_numpy(), atol=tol), \
        f"有限值不一致:\n{both.loc[fin].head()}"
    nan_a, nan_b = both["a"].isna(), both["b"].isna()
    assert (nan_a == nan_b).all(), f"NaN 位置不一致:\n{both.assign(na=nan_a, nb=nan_b)}"


# ---------------------------------------------------------------------------
# 等价性：向量化 RankIC == pandas spearman
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("seed", [0, 1, 2, 7, 42])
@pytest.mark.parametrize("shape", [(30, 200), (60, 400), (120, 150)])
def test_rankic_equals_pandas_spearman(seed, shape):
    ns, nd = shape
    f, r = _make_panel(ns, nd, seed, frac_nan=0.05)
    assert_series_close(rankic_series(f, r), _ref_rankic(f, r))


@pytest.mark.parametrize("seed", [3, 11])
def test_rankic_with_const_cross_section(seed):
    """常量截面 / 高 NaN 比例 / 并列值 等边界。"""
    f, r = _make_panel(40, 250, seed, frac_nan=0.15, inject_const=True)
    assert_series_close(rankic_series(f, r), _ref_rankic(f, r))

    f2, r2 = _make_panel(40, 250, seed + 1, frac_nan=0.1, integer=True)
    assert_series_close(rankic_series(f2, r2), _ref_rankic(f2, r2))


def test_mean_rankic_equals_pandas():
    f, r = _make_panel(50, 300, 99, frac_nan=0.08)
    assert abs(mean_rankic(f, r) - _ref_mean_rankic(f, r)) < 1e-9


def test_compute_metrics_rankic_value():
    f, r = _make_panel(50, 300, 5, frac_nan=0.08)
    m = compute_metrics(f, r)
    assert abs(m["rankic"] - _ref_mean_rankic(f, r)) < 1e-9
    # ICIR = mean/std 必须有限且自洽
    ic = rankic_series(f, r).dropna()
    assert m["icir"] is not None and np.isfinite(m["icir"])
    assert abs(m["icir"] - float(ic.mean() / ic.std())) < 1e-9


# ---------------------------------------------------------------------------
# 预计算复用：label_rank / factor_rank 不得改变数值
# ---------------------------------------------------------------------------
def test_label_rank_reuse_identical():
    f, r = _make_panel(50, 300, 21, frac_nan=0.08)
    lr = cross_section_rank(r)
    # 不传 vs 传预计算 label_rank，必须完全一致
    a = rankic_series(f, r)
    b = rankic_series(f, label_rank=lr)
    assert_series_close(a, b)
    # factor_rank 同理
    fr = cross_section_rank(f)
    c = rankic_series(f, label_rank=lr, factor_rank=fr)
    assert_series_close(a, c)


def test_get_label_rank_cache():
    panels = make_synthetic_panel(n_symbols=60, n_dates=200, seed=0,
                                   label_window=5, label_windows=[5])
    fwd = "forward_ret_5"
    clear_label_rank_cache()
    lr1 = get_label_rank(panels["train"], fwd)
    lr2 = get_label_rank(panels["train"], fwd)
    assert lr1 is lr2  # 同面板同列应命中缓存（同一对象）
    # 数值必须等于直接排序
    assert_series_close(lr1, cross_section_rank(panels["train"][fwd]))
    clear_label_rank_cache()


def test_collect_candidates_uses_optimized_path():
    """_collect_candidates 在优化后路径下，IC 数值与地面真值一致（回归守卫）。"""
    from run_mining import _collect_candidates

    panels = make_synthetic_panel(n_symbols=60, n_dates=200, seed=123,
                                   label_window=5, label_windows=[5])
    # 取若干真实树表达式
    from factor_miner.tree.generator import Generator
    from factor_miner.tree.serialize import to_prefix
    import random
    rng = random.Random(5)
    g = Generator({"evolution": {"seed": 0, "max_depth": 4,
                                 "min_depth_init": 2, "max_depth_init": 4}}, rng)
    prefixes = [to_prefix(g.generate()) for _ in range(6)]
    cands = _collect_candidates(prefixes, panels,
                                {"data": {"label_window": 5, "label_windows": [5]},
                                 "report": {"rolling_splits": 5, "top_k": 20}},
                                has_test=True)
    # 因子全 NaN 的树会被正常跳过，故候选数 <= 输入；重点是数值正确
    assert 0 < len(cands) <= 6
    for c in cands:
        # 用 pandas 原生 spearman 重算该因子测试集 IC 作对照
        fwd = panels["test"]["forward_ret_5"]
        ref = _ref_mean_rankic(c["factor"], fwd)
        if np.isfinite(ref):
            assert abs(c["test_rankic"] - ref) < 1e-9, (c["formula"], c["test_rankic"], ref)
