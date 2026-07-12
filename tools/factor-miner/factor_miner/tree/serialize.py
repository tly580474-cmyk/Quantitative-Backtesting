"""公式树 ↔ 文本表示。

  * ``to_prefix``  / ``from_prefix``：前缀表达式，用于去重键、检查点、解析。
  * ``to_formula``：人类可读中缀公式，用于报告展示。
  * ``canonical_key``：对可交换算子排序子表达式后的规范键，提升去重灵敏度。
"""
from __future__ import annotations

import re

from factor_miner.primitives.functions import FUNCTIONS
from factor_miner.tree.node import Node

_TOKEN = re.compile(r"\(|\)|[^()\s]+")
_NUM = re.compile(r"-?\d+(\.\d+)?(e-?\d+)?$", re.I)


def to_prefix(node: Node, canonical: bool = False) -> str:
    if node.kind == "terminal":
        if node.is_constant():
            v = node.value
            if isinstance(v, float) and v.is_integer():
                return str(int(v))
            return str(v)
        return str(node.name)
    prim = FUNCTIONS.get(node.name)
    parts = [to_prefix(c, canonical) for c in node.children]
    if canonical and prim and prim.commutative:
        parts = sorted(parts)
    return "(" + node.name + " " + " ".join(parts) + ")"


def to_formula(node: Node) -> str:
    if node.kind == "terminal":
        return str(node.value) if node.is_constant() else str(node.name)
    if node.name in ("add", "sub", "mul", "div"):
        op = {"add": "+", "sub": "-", "mul": "*", "div": "/"}[node.name]
        return "(" + to_formula(node.children[0]) + " " + op + " " + to_formula(node.children[1]) + ")"
    args = [to_formula(c) for c in node.children]
    return f"{node.name}({', '.join(args)})"


def canonical_key(node: Node) -> str:
    return to_prefix(node, canonical=True)


def _tokenize(s: str):
    return _TOKEN.findall(s)


def from_prefix(s: str) -> Node:
    """解析前缀表达式回公式树。"""
    toks = _tokenize(s.strip())
    pos = 0

    def parse():
        nonlocal pos
        tok = toks[pos]
        pos += 1
        if tok == "(":
            name = toks[pos]
            pos += 1
            if name not in FUNCTIONS:
                raise ValueError(f"未知算子: {name}")
            prim = FUNCTIONS[name]
            node = Node("function", name, arity=prim.arity)
            children = []
            while toks[pos] != ")":
                children.append(parse())
            pos += 1  # 跳过 ')'
            if len(children) != prim.arity:
                raise ValueError(
                    f"{name} 期望 {prim.arity} 个子节点，实际 {len(children)}")
            node.children = children
            return node
        else:
            if _NUM.match(tok):
                return Node("terminal", None, value=float(tok), arity=0)
            return Node("terminal", tok, value=None, arity=0)

    node = parse()
    if pos != len(toks):
        raise ValueError("前缀表达式存在多余 token")
    return node
