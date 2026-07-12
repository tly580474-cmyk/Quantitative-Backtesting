"""M3 端到端集成测试：微进化 → 分析导出 → 因子库落盘（SQLite + Parquet + 轨迹）。"""
from __future__ import annotations

import copy

import pandas as pd


def test_run_mining_persists_to_library(tmp_path):
    import yaml

    from factor_miner.data.loader import make_synthetic_panel
    from factor_miner.engine.evolve import evolve
    from factor_miner.persistence import FactorLibrary
    from run_mining import _analyze_and_export, load_config

    cfg = load_config(None)
    cfg["persistence"]["enabled"] = True
    cfg["persistence"]["root"] = str(tmp_path / "lib")
    cfg["persistence"]["store_values"] = True

    panels = make_synthetic_panel(
        n_symbols=60, n_dates=120, seed=cfg["evolution"]["seed"],
        label_window=cfg["data"]["label_window"],
        label_windows=cfg["data"].get("label_windows"),
    )

    small = copy.deepcopy(cfg)
    small["evolution"]["population_size"] = 20
    small["evolution"]["generations"] = 2
    small["evolution"]["checkpoint_freq"] = 10 ** 9

    _, trace = evolve(small, panels)
    has_test = len(panels.get("test", pd.DataFrame())) > 0
    _analyze_and_export(panels, trace, small, has_test)

    lib = FactorLibrary(str(tmp_path / "lib"))
    s = lib.summary()
    assert s["total"] >= 1, "因子库未写入任何因子"
    # 轨迹 JSON 已落盘
    import os
    assert list((tmp_path / "lib" / "traces").glob("*.json"))
    # 至少存在一个因子取值 parquet
    assert list((tmp_path / "lib" / "factor_values").glob("*.parquet"))
