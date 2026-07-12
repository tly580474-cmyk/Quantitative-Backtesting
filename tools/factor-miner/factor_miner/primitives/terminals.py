"""终端集定义。

终端即公式树的叶子：数据列（面板中的列）或随机常数。
常数由进化器在生成时随机采样，本模块只负责给出"可用数据列"清单。
"""
from __future__ import annotations

# 默认终端（数据列），实际以 config 中 primitives.terminals 为准
DEFAULT_TERMINALS = [
    "open", "high", "low", "close", "volume", "amount",
    "vwap", "turnover", "market_cap", "pe_ttm", "pb", "ps_ttm",
    "returns", "log_mktcap",
]


def get_terminal_names(cfg: dict) -> list[str]:
    """从配置读取终端列名；缺省回退到 DEFAULT_TERMINALS。"""
    terms = (cfg.get("primitives", {}).get("terminals")) or DEFAULT_TERMINALS
    return list(terms)


def get_function_names(cfg: dict) -> list[str]:
    """从配置读取启用的算子名。"""
    return list(cfg.get("primitives", {}).get("functions", []))
