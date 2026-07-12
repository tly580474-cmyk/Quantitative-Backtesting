"""选择算子：锦标赛选择 + 精英保留。"""
from __future__ import annotations

import random

import numpy as np

from factor_miner.tree.node import Node


def tournament(pop: list[Node], k: int, rng: random.Random) -> Node:
    best: Node | None = None
    for _ in range(k):
        ind = pop[rng.randrange(len(pop))]
        f = ind.fitness
        if f is None or not np.isfinite(f):
            continue
        if best is None or f > best.fitness:
            best = ind
    if best is None:  # 种群全无效时随机取
        best = pop[rng.randrange(len(pop))]
    return best.clone()


def select_parents(pop: list[Node], k: int, rng: random.Random) -> tuple[Node, Node]:
    return tournament(pop, k, rng), tournament(pop, k, rng)


def elite(pop: list[Node], n: int) -> list[Node]:
    valid = [p for p in pop if p.fitness is not None and np.isfinite(p.fitness)]
    valid.sort(key=lambda x: x.fitness, reverse=True)
    return [p.clone() for p in valid[:n]]
