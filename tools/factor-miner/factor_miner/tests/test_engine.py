"""遗传操作（交叉/变异/选择）合法性与约束测试。"""
from __future__ import annotations

import random

from factor_miner.engine.crossover import subtree_crossover
from factor_miner.engine.mutation import mutate
from factor_miner.engine.selection import elite, tournament
from factor_miner.tree.generator import Generator
from factor_miner.tree.node import Node
from factor_miner.tree.serialize import from_prefix, to_prefix


def test_crossover_valid_and_depth_bounded(cfg):
    rng = random.Random(1)
    g = Generator(cfg, rng)
    mx = cfg["evolution"]["max_depth"]
    for _ in range(100):
        p1, p2 = g.generate(), g.generate()
        c1, c2 = subtree_crossover(p1, p2, random.Random(2), mx)
        assert c1.depth() <= mx and c2.depth() <= mx
        # 可序列化往返
        from_prefix(to_prefix(c1))
        from_prefix(to_prefix(c2))


def test_crossover_changes_expression(cfg):
    rng = random.Random(11)
    g = Generator(cfg, rng)
    p1, p2 = g.generate(), g.generate()
    c1, c2 = subtree_crossover(p1, p2, random.Random(12), cfg["evolution"]["max_depth"])
    # 至少其中一个与父代不同（大概率）
    assert (to_prefix(c1) != to_prefix(p1)) or (to_prefix(c2) != to_prefix(p2))


def test_mutation_valid_and_depth_bounded(cfg):
    rng = random.Random(21)
    g = Generator(cfg, rng)
    mx = cfg["evolution"]["max_depth"]
    for _ in range(100):
        n = g.generate()
        m = mutate(n, random.Random(22), g, mx)
        assert m.depth() <= mx
        from_prefix(to_prefix(m))


def test_tournament_prefers_better():
    pop = [Node("terminal", "close") for _ in range(20)]
    for i, p in enumerate(pop):
        p.fitness = float(i)
    rng = random.Random(31)
    wins = 0
    for _ in range(50):
        b = tournament(pop, 5, rng)
        if b.fitness >= 15:
            wins += 1
    assert wins > 30  # 锦标赛偏好高适应度


def test_elite_returns_top(cfg):
    pop = [Node("terminal", "close") for _ in range(20)]
    for i, p in enumerate(pop):
        p.fitness = float(i)
    top = elite(pop, 3)
    assert len(top) == 3
    assert all(t.fitness >= 17 for t in top)
