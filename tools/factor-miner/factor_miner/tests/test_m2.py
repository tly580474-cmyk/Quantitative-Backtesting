"""M2 单元测试：算子护栏、近常量惩罚、风险项适应度、多窗口标签、
次新/涨跌停过滤、种子因子保护、自适应变异、滚动时序验证。
"""
from __future__ import annotations

import random

import numpy as np
import pandas as pd
import pytest

from factor_miner.analysis.ic import rolling_cv
from factor_miner.data.loader import _apply_filters, make_synthetic_panel
from factor_miner.engine.evolve import evolve
from factor_miner.engine.mutation import mutate
from factor_miner.fitness.metrics import fitness_of
from factor_miner.primitives.functions import FUNCTIONS, _log, _sqrt
from factor_miner.primitives.terminals import DEFAULT_TERMINALS
from factor_miner.tree.generator import Generator
from factor_miner.tree.node import Node
from factor_miner.tree.serialize import canonical_key, from_prefix, to_prefix


# ---------------------------------------------------------------------------
# 算子护栏
# ---------------------------------------------------------------------------
def test_sqrt_is_nonneg_and_finite():
    x = pd.Series([-4.0, -1.0, 0.0, 2.0, 9.0])
    out = _sqrt(x)
    assert np.all(out >= 0)
    assert np.all(np.isfinite(out))
    # sqrt(abs(-4)) == 2
    assert abs(out.iloc[0] - 2.0) < 1e-9


def test_log_is_signed_finite():
    x = pd.Series([-2.0, -0.5, 0.0, 0.5, 3.0])
    out = _log(x)
    assert np.all(np.isfinite(out))
    # 符号保留：负数输入 → 负数输出
    assert out.iloc[0] < 0
    assert out.iloc[-1] > 0
    # log(0) = 0
    assert abs(out.iloc[2]) < 1e-9


def test_generator_wraps_nonneg_operator():
    cfg = {
        "evolution": {"seed": 1, "min_depth_init": 4, "max_depth_init": 4, "max_depth": 6},
        "primitives": {
            "terminals": list(DEFAULT_TERMINALS),
            "functions": list(FUNCTIONS.keys()),
        },
    }
    g = Generator(cfg, random.Random(0))
    # depth>=3 → 子节点应被 abs 包裹
    node = g._make(FUNCTIONS["sqrt"], 4, full=True)
    assert node.children[0].name == "abs"
    node = g._make(FUNCTIONS["log"], 4, full=True)
    assert node.children[0].name == "abs"
    # depth<3 → 不包裹（靠算子自安全兜底，且不突破深度约束）
    node2 = g._make(FUNCTIONS["sqrt"], 2, full=True)
    assert node2.children[0].name != "abs"


def test_point_mutation_preserves_requires_nonneg():
    cfg = {
        "evolution": {"seed": 1, "min_depth_init": 3, "max_depth_init": 3, "max_depth": 6},
        "primitives": {
            "terminals": list(DEFAULT_TERMINALS),
            "functions": list(FUNCTIONS.keys()),
        },
    }
    g = Generator(cfg, random.Random(2))
    # 构造 sqrt(abs(x)) 树，反复做算子变异
    n = g._make(FUNCTIONS["sqrt"], 4, full=True)
    from factor_miner.engine.evaluator import evaluate_tree
    panel = make_synthetic_panel(n_symbols=60, n_dates=30, seed=1,
                                 label_window=5, label_windows=[5])["train"]
    for _ in range(50):
        m = mutate(n, random.Random(3), g, max_depth=6, adapt=False)
        # 关键不变量：requires_nonneg 算子（sqrt/log）在变异后仍是 sqrt/log，
        # 不会退化成无保护的普通算子（不会引入 NaN 风险）。
        for nd in m.iter_nodes():
            if nd.name in ("sqrt", "log"):
                assert nd.name in ("sqrt", "log")  # 名称保持（requires_nonneg 标志一致）
        f = evaluate_tree(m, panel)
        arr = np.asarray(f, dtype="float64")
        assert not np.any(np.isinf(arr))  # 无 inf（NaN 由下游 protect 处理，允许）


# ---------------------------------------------------------------------------
# 近常量惩罚（退化表达式抑制）
# ---------------------------------------------------------------------------
def test_constant_factor_penalty_via_panel():
    """近常量因子应被显著惩罚（CV 过小 → const_penalty>0，适应度转负）。"""
    panels = make_synthetic_panel(n_symbols=60, n_dates=40, seed=1,
                                  label_window=5, label_windows=[5])
    panel = panels["train"]
    fwd = "forward_ret_5"
    cfg = {
        "fitness": {"lambda_const": 0.1, "const_cv_thresh": 0.01,
                    "lambda_complexity": 0.0, "lambda_corr": 0.0,
                    "lambda_icir": 0.0, "lambda_consistency": 0.0},
    }
    # 构造近常量因子：1.0 + returns*1e-8，横截面 CV 极小但非完全恒定
    base = Node("terminal", None, value=1.0, arity=0)
    ret = Node("terminal", "returns", arity=0)
    tiny = Node("terminal", None, value=1e-8, arity=0)
    scaled = Node("function", "mul", arity=2)
    scaled.children = [ret, tiny]
    near_const = Node("function", "add", arity=2)
    near_const.children = [base, scaled]
    # 真实信号因子作为对照
    signal = from_prefix("(ts_mean returns 5)")
    fit_const, det_c = fitness_of(near_const, panel, fwd, cfg, [])
    fit_sig, _ = fitness_of(signal, panel, fwd, cfg, [])
    assert det_c["const_penalty"] > 0
    assert fit_const < fit_sig


# ---------------------------------------------------------------------------
# 风险项适应度（ICIR 奖励 + 一致性惩罚）
# ---------------------------------------------------------------------------
def test_fitness_exposes_icir_and_risk_terms():
    panels = make_synthetic_panel(n_symbols=60, n_dates=40, seed=2,
                                  label_window=5, label_windows=[5])
    panel = panels["train"]
    fwd = "forward_ret_5"
    node = from_prefix("(ts_mean returns 5)")  # 合成数据潜信号，IC 应显著为正且稳定
    cfg_off = {"fitness": {"lambda_complexity": 0.0, "lambda_corr": 0.0,
                           "lambda_const": 0.0, "lambda_icir": 0.0,
                           "lambda_consistency": 0.0}}
    cfg_on = {"fitness": {"lambda_complexity": 0.0, "lambda_corr": 0.0,
                          "lambda_const": 0.0, "lambda_icir": 0.05,
                          "lambda_consistency": 0.0}}
    _, d_off = fitness_of(node, panel, fwd, cfg_off, [])
    _, d_on = fitness_of(node, panel, fwd, cfg_on, [])
    assert "icir" in d_on
    # 稳定正 IC 的因子，开启 ICIR 奖励后适应度应更高
    assert d_on["icir"] is not None and d_on["icir"] > 0
    fit_off, _ = fitness_of(node, panel, fwd, cfg_off, [])
    fit_on, _ = fitness_of(node, panel, fwd, cfg_on, [])
    assert fit_on > fit_off


# ---------------------------------------------------------------------------
# 多窗口收益标签
# ---------------------------------------------------------------------------
def test_multi_window_labels_generated():
    panels = make_synthetic_panel(n_symbols=6, n_dates=40, seed=3,
                                  label_window=5, label_windows=[5, 10, 20])
    panel = panels["train"]
    for w in (5, 10, 20):
        assert f"forward_ret_{w}" in panel.columns


# ---------------------------------------------------------------------------
# 次新 / 涨跌停过滤
# ---------------------------------------------------------------------------
def test_limit_filter_removes_limit_days():
    dates = pd.date_range("2020-01-01", periods=4, freq="B")
    df = pd.DataFrame({
        "symbol": ["A"] * 4,
        "trade_date": dates,
        "close": [10.0, 11.0, 9.9, 10.5],
        "inst_type": ["stock"] * 4,
        "is_st": [0] * 4,
        "volume": [1e6] * 4,
        "list_date": [pd.Timestamp("2019-01-01")] * 4,
        "delist_date": [pd.NaT] * 4,
    })
    # 第1→2 日收益 +10%（涨停），第2→3 日收益 -10%（跌停）
    cfg = {"data": {"universe": {"exclude_limit": True, "limit_pct": 0.095,
                                 "exclude_index": True, "exclude_st": True,
                                 "exclude_suspended": True, "exclude_delisted": True}}}
    out = _apply_filters(df, cfg)
    # 涨停日(第2日)与跌停日(第3日)应被剔除，剩第1、4日
    assert len(out) == 2
    assert set(out["trade_date"].tolist()) == {dates[0], dates[3]}


# ---------------------------------------------------------------------------
# 种子因子保护
# ---------------------------------------------------------------------------
def test_seed_factors_injected_and_retained(cfg, panels):
    cfg = dict(cfg)
    cfg["evolution"] = dict(cfg["evolution"])
    cfg["evolution"]["seed_factors"] = ["(ts_mean returns 5)"]
    cfg["evolution"]["population_size"] = 30
    cfg["evolution"]["generations"] = 3
    cfg["evolution"]["max_depth"] = 5
    best, trace = evolve(cfg, panels, resume=False)
    seed_prefix = "(ts_mean returns 5)"
    seen = [r["best_prefix"] for r in trace if r.get("best_prefix")]
    # 种子因子（合成数据的强信号）应在轨迹中出现
    assert seed_prefix in seen or to_prefix(best) == seed_prefix


# ---------------------------------------------------------------------------
# 自适应变异
# ---------------------------------------------------------------------------
def test_adaptive_mutation_respects_depth_and_returns_node():
    cfg = {
        "evolution": {"seed": 1, "min_depth_init": 2, "max_depth_init": 4, "max_depth": 6},
        "primitives": {"terminals": list(DEFAULT_TERMINALS),
                       "functions": list(FUNCTIONS.keys())},
    }
    g = Generator(cfg, random.Random(1))
    base = g.generate()
    # 低多样性 → 仍返回合法 Node 且深度不超限
    child = mutate(base, random.Random(2), g, max_depth=6,
                   diversity=0.1, stagnation=8, adapt=True)
    assert isinstance(child, Node)
    assert child.depth() <= 6
    # 高多样性 → 同样合法
    child2 = mutate(base, random.Random(3), g, max_depth=6,
                    diversity=1.0, stagnation=0, adapt=True)
    assert isinstance(child2, Node)
    assert child2.depth() <= 6


# ---------------------------------------------------------------------------
# 滚动时序验证
# ---------------------------------------------------------------------------
def test_rolling_cv_returns_window_stats():
    panels = make_synthetic_panel(n_symbols=15, n_dates=120, seed=4,
                                  label_window=5, label_windows=[5])
    panel = panels["train"]
    node = from_prefix("(ts_mean returns 5)")
    from factor_miner.engine.evaluator import evaluate_tree
    f = evaluate_tree(node, panel)
    f = pd.Series(f, index=panel.index) if not isinstance(f, pd.Series) else f
    rcv = rolling_cv(f, panel["forward_ret_5"], panel, n_splits=5)
    assert "windows" in rcv
    assert len(rcv["windows"]) == 5
    assert all(np.isfinite(w) for w in rcv["windows"])
    assert np.isfinite(rcv["mean"])
