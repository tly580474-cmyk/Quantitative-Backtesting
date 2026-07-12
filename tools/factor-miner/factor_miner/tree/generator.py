"""随机公式树生成（ramped half-and-half，带深度约束）。

- **full**：每条分支都填满到目标深度（内部节点直到叶子）。
- **grow**：每一步以一定概率提前变成终端，产生更浅、更多样的树。

带窗口参数的算子（window_last）会在末位插入一个窗口常数子节点。
"""
from __future__ import annotations

import random

from factor_miner.primitives.functions import WINDOWS, enabled_functions
from factor_miner.primitives.terminals import get_terminal_names
from factor_miner.tree.node import Node


class Generator:
    def __init__(self, cfg: dict, rng: random.Random | None = None):
        self.cfg = cfg
        self.rng = rng or random.Random(cfg.get("evolution", {}).get("seed", 0))
        self.terminals = get_terminal_names(cfg)
        cr = cfg.get("primitives", {}).get("constants", {})
        self.const_min = float(cr.get("min", -1.0))
        self.const_max = float(cr.get("max", 1.0))
        self.p_const = float(cr.get("p_const", 0.1))
        self.funcs = enabled_functions(cfg)

    # ---- 终端 ----
    def _terminal(self) -> Node:
        if self.rng.random() < self.p_const:
            v = self.rng.uniform(self.const_min, self.const_max)
            return Node("terminal", None, value=v, arity=0)
        name = self.rng.choice(self.terminals)
        return Node("terminal", name, value=None, arity=0)

    def _window_node(self) -> Node:
        return Node("terminal", None, value=int(self.rng.choice(WINDOWS)), arity=0)

    # ---- 内部节点 ----
    def _make(self, prim, depth: int, full: bool) -> Node:
        node = Node("function", prim.name, arity=prim.arity)
        for _ in range(prim.n_series_args):
            # 算子护栏：requires_nonneg 的算子（sqrt/log）把子节点包一层 abs，
            # 保证输入恒非负。仅在 depth>=3 时包裹（abs 占一层，须保证不突破深度约束）；
            # 更浅时直接生成普通子节点，由算子自身的「自安全」实现（sqrt(abs(x)) 等）兜底。
            if prim.requires_nonneg and depth >= 3:
                inner = self._full(depth - 2) if full else self._grow(depth - 2)
                abs_node = Node("function", "abs", arity=1)
                abs_node.children.append(inner)
                child = abs_node
            else:
                child = self._full(depth - 1) if full else self._grow(depth - 1)
            node.children.append(child)
        if prim.window_last:
            node.children.append(self._window_node())
        return node

    def _full(self, depth: int) -> Node:
        if depth <= 0:
            return self._terminal()
        prim = self.rng.choice(self.funcs)
        return self._make(prim, depth, full=True)

    def _grow(self, depth: int) -> Node:
        if depth <= 0:
            return self._terminal()
        if self.rng.random() < 0.3:
            return self._terminal()
        prim = self.rng.choice(self.funcs)
        return self._make(prim, depth, full=False)

    def generate(self, min_depth: int | None = None, max_depth: int | None = None) -> Node:
        ev = self.cfg.get("evolution", {})
        md = min_depth if min_depth is not None else int(ev.get("min_depth_init", 2))
        xd = max_depth if max_depth is not None else int(ev.get("max_depth_init", 4))
        d = self.rng.randint(md, xd)
        if self.rng.random() < 0.5:
            return self._full(d)
        return self._grow(d)

    def generate_subtree(self, max_depth: int) -> Node:
        """生成用于子树变异的随机子树。"""
        d = self.rng.randint(1, max(1, max_depth))
        if self.rng.random() < 0.5:
            return self._full(d)
        return self._grow(d)
