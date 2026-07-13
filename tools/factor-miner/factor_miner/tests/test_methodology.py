"""研究方法学门禁回归测试。"""
from __future__ import annotations

import numpy as np
import pandas as pd

from factor_miner.analysis.layer import layer_backtest
from factor_miner.data.loader import _build_derived, make_synthetic_panel
from factor_miner.engine.evolve import _rolling_folds
from factor_miner.engine.evaluator import as_series, evaluate_tree
from factor_miner.fitness.metrics import fitness_of, mean_rankic
from factor_miner.tree.serialize import from_prefix
from run_mining import (
    _build_run_manifest, _load_completed_seed, _save_completed_seed,
)


def test_synthetic_panel_is_strictly_time_split():
    panels = make_synthetic_panel(n_symbols=10, n_dates=100, seed=7)

    train_dates = panels["train"].index.get_level_values(1)
    valid_dates = panels["valid"].index.get_level_values(1)
    test_dates = panels["test"].index.get_level_values(1)

    assert panels["data_kind"] == "synthetic"
    assert train_dates.max() < valid_dates.min()
    assert valid_dates.max() < test_dates.min()
    assert len(set(train_dates) & set(valid_dates)) == 0
    assert len(set(valid_dates) & set(test_dates)) == 0


def test_default_config_disables_train_validation_combination(cfg):
    assert cfg["fitness"]["use_combined_panel"] is False


def test_real_label_enters_next_open_and_exits_horizon_close():
    dates = pd.date_range("2024-01-02", periods=5, freq="B")
    raw = pd.DataFrame({
        "symbol": ["A"] * 5,
        "trade_date": dates,
        "open": [10.0, 11.5, 12.5, 13.5, 14.5],
        "close": [11.0, 12.0, 13.0, 14.0, 15.0],
        "volume": [100.0] * 5,
        "amount": [1000.0] * 5,
        "market_cap": [1e9] * 5,
        "pe_ttm": [10.0] * 5,
        "pb": [1.0] * 5,
        "ps_ttm": [2.0] * 5,
        "turnover": [1.0] * 5,
    })
    out = _build_derived(raw, {"data": {"label_window": 2, "label_windows": [2]}})
    assert out.loc[0, "forward_ret_2"] == 13.0 / 11.5 - 1.0


def test_label_rejects_untradable_next_open_limit_move():
    dates = pd.date_range("2024-01-02", periods=3, freq="B")
    raw = pd.DataFrame({
        "symbol": ["A"] * 3, "trade_date": dates, "open": [10.0, 12.0, 12.1],
        "close": [10.0, 12.0, 12.2], "volume": [100.0] * 3, "amount": [1000.0] * 3,
        "market_cap": [1e9] * 3, "pe_ttm": [10.0] * 3, "pb": [1.0] * 3,
        "ps_ttm": [2.0] * 3, "turnover": [1.0] * 3,
    })
    out = _build_derived(raw, {"data": {"label_window": 2, "label_windows": [2],
                                          "universe": {"limit_pct": 0.095}}})
    assert np.isnan(out.loc[0, "forward_ret_2"])


def test_walk_forward_is_expanding_and_validation_is_future_only(panels):
    folds = _rolling_folds(panels["train"], n_folds=3)
    dates = panels["train"].index.get_level_values(1)
    previous_train_count = 0
    for train_mask, valid_mask in folds:
        train_dates = dates[train_mask].unique()
        valid_dates = dates[valid_mask].unique()
        assert len(train_dates) > previous_train_count
        assert train_dates.max() < valid_dates.min()
        previous_train_count = len(train_dates)


def test_rolling_fitness_reuses_daily_rankic_without_changing_value(cfg, panels):
    panel = panels["train"]
    fwd_col = "forward_ret_5"
    node = from_prefix("(ts_mean returns 5)")
    folds = _rolling_folds(panel, n_folds=3)
    dates = panel.index.get_level_values(1)
    valid_dates = [dates[valid_mask].unique() for _, valid_mask in folds]

    regular_fit, regular_detail = fitness_of(node, panel, fwd_col, cfg, [])
    factor = as_series(evaluate_tree(node, panel), panel)
    fold_bases = [mean_rankic(factor[mask], panel.loc[mask, fwd_col])
                  for _, mask in folds]
    expected = float(np.mean([value for value in fold_bases if np.isfinite(value)]))
    rolling_fit, rolling_detail = fitness_of(
        node, panel, fwd_col, cfg, [], rolling_valid_dates=valid_dates)

    assert np.isclose(rolling_detail["base"], expected)
    assert np.isclose(rolling_fit, regular_fit + expected - regular_detail["base"])
    assert rolling_detail["rolling"] is True


def test_completed_seed_trace_round_trip(tmp_path):
    trace = [{"generation": 0, "best_prefix": "returns", "seed": 7}]
    _save_completed_seed(str(tmp_path), 7, trace)
    assert _load_completed_seed(str(tmp_path), 7) == trace
    assert _load_completed_seed(str(tmp_path), 8) is None


def test_multiday_layer_backtest_uses_non_overlapping_periods():
    symbols = [f"S{i:02d}" for i in range(20)]
    dates = pd.date_range("2024-01-02", periods=30, freq="B")
    index = pd.MultiIndex.from_product([symbols, dates], names=["symbol", "trade_date"])
    # MultiIndex.from_product 以 symbol 为外层，需要按索引显式生成截面分数。
    factor = pd.Series(index.get_level_values("symbol").map(
        {s: i for i, s in enumerate(symbols)}).astype(float), index=index)
    fwd = pd.Series(factor.to_numpy() * 0.001, index=index, name="forward_ret_5")

    result = layer_backtest(factor, fwd, n_groups=5)

    assert result["holding_days"] == 5
    assert result["periods_per_year"] == 252 / 5
    assert result["portfolio_method"] == "non_overlapping"
    assert len(result["long_short_series"]) == 6


def test_layer_backtest_deducts_round_trip_long_short_costs():
    symbols = [f"S{i:02d}" for i in range(20)]
    dates = pd.date_range("2024-01-02", periods=20, freq="B")
    index = pd.MultiIndex.from_product([symbols, dates], names=["symbol", "trade_date"])
    factor = pd.Series(index.get_level_values("symbol").map(
        {s: i for i, s in enumerate(symbols)}).astype(float), index=index)
    fwd = pd.Series(factor.to_numpy() * 0.001, index=index, name="forward_ret_1")
    gross = layer_backtest(factor, fwd)
    net = layer_backtest(factor, fwd, total_cost_bps=10)
    delta = gross["long_short_series"] - net["long_short_series"]
    assert np.allclose(delta, 0.004)


def test_run_manifest_binds_reproducibility_lineage_without_password(cfg, panels):
    cfg["data"]["password"] = "must-not-leak"
    panels["lineage"] = {"snapshot_id": "snapshot-v1", "source_version": "source-v1"}
    manifest = _build_run_manifest(panels, cfg, ["returns"], [{"prefix": "returns"}])
    assert manifest["data_lineage"]["snapshot_id"] == "snapshot-v1"
    assert manifest["random_seed"] == cfg["evolution"]["seed"]
    assert len(manifest["config_sha256"]) == 64
    assert len(manifest["code_sha256"]) == 64
    assert manifest["runtime"]["python"]
    assert "pandas" in manifest["runtime"]["packages"]
    assert "password" not in manifest["config"]["data"]
