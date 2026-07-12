"""子树交叉（GP 核心）：交换两个父代中的随机子树。

返回两个子代；若交换后任一子代深度超过 max_depth，则回退为父代克隆，
以保证表达式始终受深度约束。
"""
from __future__ import annotations

import random

from factor_miner.tree.node import Node


def random_subtree_with_parent(node: Node, rng: random.Random, require_internal: bool = False):
    """随机返回一个子树及其父节点引用 (parent, index, child)。

    parent=None 表示 child 即为根节点。
    """
    candidates = [(None, None, node)]
    stack = [(node, i, c) for i, c in enumerate(node.children)]
    while stack:
        parent, idx, child = stack.pop()
        candidates.append((parent, idx, child))
        for i, c in enumerate(child.children):
            stack.append((child, i, c))
    if require_internal:
        cands = [c for c in candidates if c[2].children]
        if not cands:
            return None
        return rng.choice(cands)
    return rng.choice(candidates)


def subtree_crossover(p1: Node, p2: Node, rng: random.Random,
                      max_depth: int, max_tries: int = 5) -> tuple[Node, Node]:
    for _ in range(max_tries):
        c1 = p1.clone()
        c2 = p2.clone()
        s1 = random_subtree_with_parent(c1, rng, require_internal=True)
        s2 = random_subtree_with_parent(c2, rng, require_internal=True)
        if s1 is None or s2 is None:
            return c1, c2
        pa1, idx1, sub1 = s1
        pa2, idx2, sub2 = s2
        if pa1 is None:
            c1 = sub2
        else:
            pa1.children[idx1] = sub2
        if pa2 is None:
            c2 = sub1
        else:
            pa2.children[idx2] = sub1
        if c1.depth() <= max_depth and c2.depth() <= max_depth:
            return c1, c2
    # 多次尝试仍超限 → 回退父代
    return p1.clone(), p2.clone()
