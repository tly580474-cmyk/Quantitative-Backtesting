"""数据层：过滤逻辑、面板结构、防未来函数测试。"""
from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from factor_miner.data.loader import _apply_filters, make_synthetic_panel


def test_apply_filters_excludes_index_st_suspended_delisted():
    df = pd.DataFrame({
        "symbol": ["A", "B", "C", "D", "E"],
        "inst_type": ["stock", "index", "stock", "stock", "stock"],
        "is_st": [0, 0, 1, 0, 0],
        "volume": [100.0, 200.0, 300.0, 0.0, 100.0],
        "list_date": ["2000-01-01"] * 5,
        "delist_date": [None, None, None, "2001-01-01", None],
        "trade_date": ["2020-01-01"] * 5,
        "close": [1.0] * 5,
    })
    cfg = {"data": {"universe": {
        "exclude_index": True, "exclude_st": True,
        "exclude_suspended": True, "exclude_delisted": True,
        "recent_listing_days": 0}}}
    out = _apply_filters(df, cfg)
    assert set(out["symbol"]) == {"A", "E"}


def test_synthetic_panel_structure(panels):
    assert isinstance(panels["train"].index, pd.MultiIndex)
    cols = panels["train"].columns
    for c in ["open", "high", "low", "close", "volume", "vwap",
              "returns", "industry", "forward_ret_5"]:
        assert c in cols
    assert panels["train"].index.get_level_values(0).nunique() > 0


def test_synthetic_signal_present(panels):
    # ts_mean(returns,5) 应与 forward_ret_5 正相关（信号被注入）
    from factor_miner.fitness.metrics import mean_rankic
    from factor_miner.tree.serialize import from_prefix
    from factor_miner.engine.evaluator import evaluate_tree

    node = from_prefix("(ts_mean returns 5)")
    f = evaluate_tree(node, panels["train"])
    ic = mean_rankic(f, panels["train"]["forward_ret_5"])
    assert np.isfinite(ic) and ic > 0


def test_no_future_function_in_terminals(panels):
    # 终端集不应包含任何未来收益标签列（防前视）
    terminals = ["open", "high", "low", "close", "volume", "amount",
                 "vwap", "turnover", "market_cap", "pe_ttm", "pb", "ps_ttm", "returns"]
    cols = set(panels["train"].columns)
    for t in terminals:
        assert t in cols
    assert "forward_ret_5" not in terminals
