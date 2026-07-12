from __future__ import annotations

import hashlib
import json

import pandas as pd

from factor_miner.data.loader import build_panel


def test_build_panel_reads_published_snapshot(tmp_path, cfg):
    snapshot_id = "fixture-snapshot"
    partition = tmp_path / snapshot_id / "bars" / "year=2024" / "data.parquet"
    partition.parent.mkdir(parents=True)
    rows = []
    dates = pd.date_range("2024-01-02", periods=24, freq="B")
    for instrument in range(1, 5):
        for offset, date in enumerate(dates):
            close = 10.0 + instrument + offset * 0.1
            rows.append({
                "instrumentKey": instrument, "market": "SZ", "symbol": f"00000{instrument}",
                "name": f"股票{instrument}", "industry": "测试", "tradeDate": date.date(),
                "open": close - 0.05, "high": close + 0.1, "low": close - 0.1,
                "close": close, "previousClose": close - 0.1, "volume": 1000,
                "amount": 10000.0, "turnoverRatePct": 1.0, "totalMarketCap": 1e9,
                "peTtm": 10.0, "pb": 1.0, "psTtm": 2.0,
            })
    pd.DataFrame(rows).to_parquet(partition, index=False)
    digest = hashlib.sha256(partition.read_bytes()).hexdigest()
    manifest = {
        "schemaVersion": 1, "snapshotId": snapshot_id, "sourceVersion": "source-v1",
        "createdAt": "2024-02-01T00:00:00Z", "status": "validated", "rowCount": len(rows),
        "instrumentCount": 4, "minDate": str(dates[0].date()), "maxDate": str(dates[-1].date()),
        "partitions": [{"year": 2024, "relativePath": "bars/year=2024/data.parquet",
                        "rows": len(rows), "bytes": partition.stat().st_size,
                        "minDate": str(dates[0].date()), "maxDate": str(dates[-1].date()), "sha256": digest}],
    }
    (tmp_path / "current.json").write_text(json.dumps({"snapshotId": snapshot_id}), encoding="utf-8")
    (tmp_path / snapshot_id / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    cfg["data"].update({
        "source": "snapshot", "snapshot_root": str(tmp_path), "start_date": str(dates[0].date()),
        "end_date": str(dates[-1].date()), "train_end": str(dates[7].date()),
        "valid_end": str(dates[15].date()),
        "sample_symbols": 0, "verify_snapshot_checksums": True,
    })

    panels = build_panel(cfg)

    assert panels["data_kind"] == "published_snapshot"
    assert panels["lineage"]["snapshot_id"] == snapshot_id
    assert panels["lineage"]["source_version"] == "source-v1"
    assert panels["train"].index.get_level_values(0).nunique() == 4
    assert panels["train"].index.get_level_values(0)[0].startswith("SZ.")
    assert panels["train"].index.get_level_values(1).max() < panels["valid"].index.get_level_values(1).min()
