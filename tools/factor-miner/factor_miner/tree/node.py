"""公式树节点。

个体 = 一棵表达式树：
  * 叶子 (kind='terminal')：数据列(name) 或 常数(value, is_constant=True)
  * 内部节点 (kind='function')：算子(name)，arity 个子节点

求值、克隆、深度/规模统计均在此实现。
"""
from __future__ import annotations


class Node:
    __slots__ = ("kind", "name", "value", "children", "arity", "fitness", "metrics")

    def __init__(self, kind: str, name, value=None, children=None, arity: int = 0):
        self.kind = kind            # 'terminal' | 'function'
        self.name = name            # 列名 / 算子名 / None(常数)
        self.value = value          # 仅常数终端有值
        self.children = children or []
        self.arity = arity
        self.fitness = None         # 适应度（由进化器填充）
        self.metrics = None         # 验收指标（由分析器填充）

    # ---- 结构属性 ----
    def depth(self) -> int:
        if not self.children:
            return 0
        return 1 + max(c.depth() for c in self.children)

    def size(self) -> int:
        return 1 + sum(c.size() for c in self.children)

    def is_constant(self) -> bool:
        return self.kind == "terminal" and self.value is not None

    def clone(self) -> "Node":
        c = Node(
            kind=self.kind,
            name=self.name,
            value=self.value,
            children=[child.clone() for child in self.children],
            arity=self.arity,
        )
        c.fitness = self.fitness
        c.metrics = self.metrics
        return c

    def iter_nodes(self):
        """深度优先遍历所有节点（含自身）。"""
        yield self
        for c in self.children:
            yield from c.iter_nodes()

    def count_nodes(self) -> int:
        return self.size()

    def __repr__(self) -> str:
        if self.kind == "terminal":
            return f"T({self.name if not self.is_constant() else self.value})"
        return f"F({self.name},{len(self.children)})"
