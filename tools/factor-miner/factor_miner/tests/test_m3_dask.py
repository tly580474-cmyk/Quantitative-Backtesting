"""M3-2 Dask 分块加载单元测试（无数据库，基于合成原始面板）。"""
from __future__ import annotations

import pandas as pd
import pytest

try:
    import dask.dataframe as dd  # noqa: F401
    HAS_DASK = True
except Exception:  # pragma: no cover
    HAS_DASK = False

from factor_miner.data.loader_dask import (
    build_panel_dask,
    load_parquet_panel,
    raw_to_parquet_partitions,
)


def _raw_df():
    rows = []
    dates = pd.date_range("2020-01-01", periods=6, freq="B")
    for s in range(3):
        for i, d in enumerate(dates):
            close = 10 + s + i * 0.1
            rows.append({
                "symbol": f"S{s}", "trade_date": d,
                "open": close, "high": close * 1.01, "low": close * 0.99,
                "close": close, "volume": 1e6, "amount": 1e7,
                "turnover": 2.0, "market_cap": 1e9 * (s + 1),
                "pe_ttm": 20.0, "pb": 2.0, "ps_ttm": 5.0,
                "industry": f"IND{s % 2}", "is_st": 0, "inst_type": "stock",
                "list_date": pd.Timestamp("2010-01-01"), "delist_date": pd.NaT,
            })
    return pd.DataFrame(rows)


def _cfg():
    import yaml
    with open("factor_miner/config/default.yaml", "r", encoding="utf-8") as f:
        cfg = yaml.safe_load(f)
    cfg["data"]["train_end"] = "2020-01-04"
    cfg["data"]["valid_end"] = "2020-01-07"
    return cfg


def test_raw_to_parquet_partitions(tmp_path):
    df = _raw_df()
    out = raw_to_parquet_partitions(df, str(tmp_path / "parts"), chunksize=6)
    parts = list(__import__("pathlib").Path(out).glob("part_*.parquet"))
    assert len(parts) >= 1
    import pyarrow.parquet as pq
    tot = sum(pq.read_table(p).num_rows for p in parts)
    assert tot == len(df)


def test_load_parquet_pandas(tmp_path):
    df = _raw_df()
    out = raw_to_parquet_partitions(df, str(tmp_path / "parts"), chunksize=6)
    loaded = load_parquet_panel(out, engine="pandas")
    assert isinstance(loaded, pd.DataFrame)
    assert len(loaded) == len(df)


@pytest.mark.skipif(not HAS_DASK, reason="dask 未安装")
def test_load_parquet_dask(tmp_path):
    df = _raw_df()
    out = raw_to_parquet_partitions(df, str(tmp_path / "parts"), chunksize=6)
    ddf = load_parquet_panel(out, engine="dask")
    assert hasattr(ddf, "compute")
    assert len(ddf.compute()) == len(df)


@pytest.mark.skipif(not HAS_DASK, reason="dask 未安装")
def test_build_panel_dask_pipeline(tmp_path):
    df = _raw_df()
    cache = str(tmp_path / "parts")
    raw_to_parquet_partitions(df, cache, chunksize=6)
    cfg = _cfg()
    # 已有分区 -> 跳过 MySQL 抽取，直接走分块/惰性准备
    panels = build_panel_dask(cfg, cache_dir=cache)
    assert {"train", "valid", "test"} <= set(panels.keys())
    train = panels["train"]
    assert isinstance(train, pd.DataFrame)
    assert "forward_ret_5" in train.columns
    assert "log_mktcap" in train.columns
    assert len(train) > 0
