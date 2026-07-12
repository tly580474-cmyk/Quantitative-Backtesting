"""变异算子：子树变异 / 算子变异 / 常数变异。

三者之一随机触发。变异后若深度超限则回退为原个体，保证深度约束。
"""
from __future__ import annotations

import random

from factor_miner.primitives.functions import FUNCTIONS
from factor_miner.tree.generator import Generator
from factor_miner.tree.node import Node
from factor_miner.engine.crossover import random_subtree_with_parent


def point_mutation(node: Node, rng: random.Random, gen: Generator) -> Node:
    """把某个内部节点的算子替换为同结构（同 arity / 同窗口属性）的其它算子。"""
    c = node.clone()
    internal = [n for n in c.iter_nodes() if n.kind == "function"]
    if not internal:
        return c
    t = rng.choice(internal)
    prim = FUNCTIONS[t.name]
    cands = [p for p in gen.funcs
             if p.name != t.name
             and p.n_series_args == prim.n_series_args
             and p.window_last == prim.window_last
             and p.requires_nonneg == prim.requires_nonneg]
    if not cands:
        return c
    new = rng.choice(cands)
    t.name = new.name
    t.arity = new.arity
    return c


def subtree_mutation(node: Node, rng: random.Random, gen: Generator,
                     max_depth: int) -> Node:
    c = node.clone()
    s = random_subtree_with_parent(c, rng)
    if s is None:
        return c
    pa, idx, _ = s
    new_sub = gen.generate_subtree(max_depth)
    if pa is None:
        c = new_sub
    else:
        pa.children[idx] = new_sub
    if c.depth() > max_depth:
        return node.clone()
    return c


def constant_mutation(node: Node, rng: random.Random, gen: Generator) -> Node:
    c = node.clone()
    consts = [n for n in c.iter_nodes() if n.is_constant()]
    if not consts:
        return c
    t = rng.choice(consts)
    t.value = float(t.value) + rng.uniform(-0.2, 0.2)
    return c


def mutate(node: Node, rng: random.Random, gen: Generator, max_depth: int,
           mutation_rate: float = 0.2, diversity: float = 1.0,
           stagnation: int = 0, adapt: bool = True) -> Node:
    """变异入口。

    adapt=True 时根据种群状态自适应调整：
      * 多样性低（diversity<0.5）→ 提高整体变异率，偏重子树变异以跳出局部最优；
      * 停滞代数高（stagnation>=5）→ 进一步抬高子树变异比例，注入更多结构探索。
    返回变异后的新个体（原个体不被修改）。
    """
    if not adapt:
        choice = rng.random()
        if choice < 0.6:
            return subtree_mutation(node, rng, gen, max_depth)
        elif choice < 0.9:
            return point_mutation(node, rng, gen)
        return constant_mutation(node, rng, gen)

    # 子树变异占比：默认 0.6，探索不足时升到 0.85
    subtree_share = 0.6
    if diversity < 0.4 or stagnation >= 5:
        subtree_share = 0.85
    elif diversity < 0.5:
        subtree_share = 0.72
    # 其余在 算子变异 / 常数变异 间按 0.75/0.25 分配
    point_share = (1 - subtree_share) * 0.75
    choice = rng.random()
    if choice < subtree_share:
        return subtree_mutation(node, rng, gen, max_depth)
    elif choice < subtree_share + point_share:
        return point_mutation(node, rng, gen)
    return constant_mutation(node, rng, gen)
