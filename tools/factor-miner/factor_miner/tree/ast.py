"""GP 公式树到主项目版本化 JSON AST 的安全转换。"""
from __future__ import annotations

from factor_miner.primitives.functions import FUNCTIONS
from factor_miner.tree.node import Node

AST_VERSION = 1
TERMINAL_MAP = {
    "open": "open", "high": "high", "low": "low", "close": "close",
    "volume": "volume", "amount": "amount", "turnover": "turnoverRatePct",
    "returns": "returns", "vwap": "vwap",
    "log_mktcap": "log_mktcap",
}
SUPPORTED_OPERATORS = {
    "add", "sub", "mul", "div", "min", "max", "neg", "abs", "log",
    "sqrt", "sign", "inv", "cs_rank", "cs_zscore", "ts_delay", "ts_delta",
    "ts_mean", "ts_std", "ts_min", "ts_max", "ts_sum",
    "cs_neutralize", "cs_indneutral",
}


def to_ast_expression(node: Node) -> dict:
    """转换为可被主项目白名单编译器接受的 AST；不支持的节点直接拒绝。"""
    return {"type": "ast", "version": AST_VERSION, "root": _to_ast_node(node)}


def _to_ast_node(node: Node) -> dict:
    if node.kind == "terminal":
        if node.is_constant():
            value = float(node.value)
            if not (-1e6 <= value <= 1e6):
                raise ValueError("AST 常数超出允许范围")
            return {"type": "constant", "value": value}
        mapped = TERMINAL_MAP.get(str(node.name))
        if mapped is None:
            raise ValueError(f"主项目 AST 不支持终端: {node.name}")
        return {"type": "terminal", "name": mapped}

    if node.name not in SUPPORTED_OPERATORS:
        raise ValueError(f"主项目 AST 不支持算子: {node.name}")
    primitive = FUNCTIONS[node.name]
    children = list(node.children)
    out = {"type": "operator", "op": node.name}
    if primitive.window_last:
        window_node = children.pop()
        if not window_node.is_constant():
            raise ValueError(f"窗口算子 {node.name} 的窗口必须是常数")
        window = int(round(float(window_node.value)))
        if window < 2 or window > 252:
            raise ValueError(f"窗口算子 {node.name} 的窗口越界: {window}")
        out["window"] = window
    out["args"] = [_to_ast_node(child) for child in children]
    return out
