"""M3-1 算力测算单元测试。"""
from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from factor_miner.analysis.benchmark import (
    benchmark_evaluate,
    benchmark_parallel_speedup,
    recommend,
    summarize,
)
from factor_miner.data.loader import make_synthetic_panel


@pytest.fixture(scope="module")
def cfg():
    import yaml
    with open("factor_miner/config/default.yaml", "r", encoding="utf-8") as f:
        return yaml.safe_load(f)


@pytest.fixture(scope="module")
def small_panel(cfg):
    return make_synthetic_panel(
        n_symbols=20, n_dates=60, seed=cfg["evolution"]["seed"],
        label_window=cfg["data"]["label_window"],
        label_windows=cfg["data"].get("label_windows"),
    )["train"]


def test_benchmark_evaluate_smoke(small_panel, cfg):
    res = benchmark_evaluate(small_panel, cfg, n_trees=10, warmup=2)
    assert "per_tree_ms" in res and "trees_per_sec" in res
    assert np.isfinite(res["per_tree_ms"]) and res["per_tree_ms"] > 0
    assert res["panel_shape"] == list(small_panel.shape)


def test_recommend_returns_keys(cfg):
    bench = {"per_tree_ms": 500.0, "abs_peak_mem_mb": 200.0,
             "panel_shape": [2400, 16]}
    rec = recommend(cfg, bench)
    for k in ("recommend_population", "recommend_generations", "recommend_n_jobs",
              "est_per_gen_s", "est_total_s", "est_total_min"):
        assert k in rec
    # 耗时随种群与代数正向、且有限
    assert np.isfinite(rec["est_total_s"]) and rec["est_total_s"] > 0
    assert rec["recommend_n_jobs"] >= 1


def test_parallel_speedup_smoke(small_panel, cfg):
    res = benchmark_parallel_speedup(small_panel, cfg, n_trees=20, n_jobs_list=(1, 2))
    assert "speedup" in res
    assert 1 in res["speedup"]
    assert np.isfinite(res["speedup"][1])  # 单线程基准
    assert np.isfinite(res["speedup"][2])


def test_summarize_writes_json(tmp_path, small_panel, cfg):
    out = tmp_path / "bench.json"
    res = summarize(small_panel, cfg, out_json=str(out), n_trees=10,
                    measure_parallel=False)
    assert out.exists()
    assert "benchmark" in res and "recommend" in res
    assert np.isfinite(res["recommend"]["est_total_s"])
