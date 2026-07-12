"""公式树生成 / 序列化 / 克隆测试。"""
from __future__ import annotations

import random

from factor_miner.tree.generator import Generator
from factor_miner.tree.node import Node
from factor_miner.tree.serialize import canonical_key, from_prefix, to_formula, to_prefix


def test_generate_depth_within_init(cfg):
    g = Generator(cfg, random.Random(0))
    md = cfg["evolution"]["max_depth_init"]
    for _ in range(300):
        n = g.generate()
        assert n.depth() <= md


def test_subtree_depth_within_max(cfg):
    g = Generator(cfg, random.Random(3))
    mx = cfg["evolution"]["max_depth"]
    for _ in range(200):
        n = g.generate_subtree(mx)
        assert n.depth() <= mx


def test_serialize_roundtrip(cfg):
    g = Generator(cfg, random.Random(5))
    for _ in range(100):
        n = g.generate()
        p = to_prefix(n)
        n2 = from_prefix(p)
        assert to_prefix(n2) == p
        assert canonical_key(n) == canonical_key(n2)


def test_clone_independent(cfg):
    n = from_prefix("(add close volume)")
    n.fitness = 0.42
    c = n.clone()
    assert to_prefix(c) == to_prefix(n)
    # 修改克隆不应影响原树
    c.children[0] = Node("terminal", "open")
    assert to_prefix(c) != to_prefix(n)
    # clone 应保留适应度
    assert c.fitness == 0.42


def test_formula_readable():
    n = from_prefix("(add (mul close volume) (ts_mean close 5))")
    f = to_formula(n)
    assert "close" in f and "volume" in f
    assert f.startswith("(")


def test_canonical_key_commutative():
    a = from_prefix("(add close volume)")
    b = from_prefix("(add volume close)")
    assert canonical_key(a) == canonical_key(b)
