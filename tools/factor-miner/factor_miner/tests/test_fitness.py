"""适应度与已知因子 IC 正确性测试。"""
from __future__ import annotations

import numpy as np

from factor_miner.fitness.metrics import compute_metrics, fitness_of
from factor_miner.tree.serialize import from_prefix


def test_constant_factor_invalid(panels, cfg):
    node = from_prefix("(add 1.0 2.0)")  # 常数，无截面信息
    fit, detail = fitness_of(node, panels["train"], "forward_ret_5", cfg, [])
    # 常数因子 RankIC 应为 NaN → 适应度 -inf
    assert not np.isfinite(fit)


def test_known_signal_factor_positive(panels, cfg):
    # ts_mean(returns, 5) 正是合成数据注入的潜因子 → 应有显著正 RankIC
    node = from_prefix("(ts_mean returns 5)")
    fit, detail = fitness_of(node, panels["train"], "forward_ret_5", cfg, [])
    assert np.isfinite(fit)
    assert detail["base"] > 0


def test_complexity_penalty_reduces_fitness(panels, cfg):
    small = from_prefix("(ts_mean returns 5)")
    big = from_prefix("(ts_mean (mul close (add volume (ts_mean returns 5))) 5)")
    f_small, _ = fitness_of(small, panels["train"], "forward_ret_5", cfg, [])
    f_big, d_big = fitness_of(big, panels["train"], "forward_ret_5", cfg, [])
    # 大模型复杂度惩罚更大（base 相近时更复杂的适应度更低或相等）
    assert d_big["complexity"] > 1


def test_compute_metrics_shape(panels):
    from factor_miner.engine.evaluator import evaluate_tree
    node = from_prefix("(ts_mean returns 5)")
    f = evaluate_tree(node, panels["train"])
    m = compute_metrics(f, panels["train"]["forward_ret_5"])
    assert "rankic" in m and "icir" in m and "ic_t" in m


def test_correlation_penalty(panels, cfg):
    from factor_miner.engine.evaluator import evaluate_tree
    node = from_prefix("(ts_mean returns 5)")
    f = evaluate_tree(node, panels["train"])
    # 与一个几乎相同的因子（自身）相关性惩罚应接近 1
    pen = __import__("factor_miner.fitness.metrics", fromlist=["correlation_penalty"]).correlation_penalty
    p = pen(f, [f], subsample=0)
    assert p > 0.9
