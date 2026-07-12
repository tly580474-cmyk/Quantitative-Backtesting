"""表达式向量化求值。

把公式树递归求值为与面板同形的 ``Series``。常数叶子返回标量（在算术中自然广播），
最终若得到标量则展开为与面板同索引的常数序列。
"""
from __future__ import annotations

import logging

import numpy as np
import pandas as pd

from factor_miner.primitives.functions import FUNCTIONS
from factor_miner.tree.node import Node

logger = logging.getLogger("factor_miner")


def evaluate_tree(node: Node, panel: pd.DataFrame):
    if node.kind == "terminal":
        if node.is_constant():
            return float(node.value)
        return panel[node.name]
    prim = FUNCTIONS[node.name]
    args = [evaluate_tree(c, panel) for c in node.children]
    try:
        if getattr(prim, "needs_panel", False):
            out = prim.func(*args, panel=panel)
        else:
            out = prim.func(*args)
    except Exception as exc:  # 防御性兜底
        logger.debug("求值异常 %s: %s", node.name, exc)
        return np.nan
    if isinstance(out, pd.Series):
        return out
    arr = np.asarray(out)
    if arr.ndim == 0:
        return float(arr)
    return pd.Series(arr, index=panel.index, dtype="float64")


def as_series(value, panel: pd.DataFrame) -> pd.Series:
    if isinstance(value, pd.Series):
        return value
    return pd.Series(float(value), index=panel.index, dtype="float64")
