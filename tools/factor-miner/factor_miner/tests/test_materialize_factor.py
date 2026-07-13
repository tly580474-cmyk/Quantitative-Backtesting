from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pandas as pd

from materialize_factor import materialize


def test_nested_factor_is_materialized_to_partitioned_parquet(tmp_path: Path):
    snapshot_id = "snapshot-test"
    root = tmp_path / "snapshots"
    bars = root / snapshot_id / "bars" / "year=2024"
    bars.mkdir(parents=True)
    rows = []
    dates = pd.date_range("2024-01-02", periods=12, freq="B")
    for day_index, trade_date in enumerate(dates):
        for instrument in range(1, 5):
            close = 10 + instrument + day_index * (0.1 + instrument * 0.01)
            rows.append({
                "instrumentKey": instrument, "market": "SH", "symbol": f"60000{instrument}",
                "name": f"S{instrument}", "industry": "fixture", "tradeDate": trade_date.date(),
                "open": close - 0.05, "high": close + 0.1, "low": close - 0.1, "close": close,
                "previousClose": close - 0.1, "volume": 1000 + instrument,
                "amount": close * (1000 + instrument), "turnoverRatePct": 1.0,
                "totalMarketCap": close * 1_000_000, "peTtm": 10.0, "pb": 1.0, "psTtm": 2.0,
            })
    parquet = bars / "data.parquet"
    pd.DataFrame(rows).to_parquet(parquet, index=False)
    digest = hashlib.sha256(parquet.read_bytes()).hexdigest()
    manifest = {
        "schemaVersion": 1, "snapshotId": snapshot_id, "sourceVersion": "source-test",
        "sourcePublishedAt": None, "createdAt": "2024-01-20T00:00:00Z", "status": "validated",
        "rowCount": len(rows), "instrumentCount": 4,
        "minDate": str(dates.min().date()), "maxDate": str(dates.max().date()),
        "partitions": [{"year": 2024, "relativePath": "bars/year=2024/data.parquet",
                        "rows": len(rows), "bytes": parquet.stat().st_size,
                        "minDate": str(dates.min().date()), "maxDate": str(dates.max().date()),
                        "sha256": digest}],
    }
    (root / snapshot_id / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    (root / "current.json").write_text(json.dumps({"snapshotId": snapshot_id}), encoding="utf-8")

    output = tmp_path / "factor-values"
    result = materialize({
        "candidate_id": "candidate-test",
        "prefix": "(cs_zscore (ts_mean close 3))",
        "warmup_days": 3,
        "start_date": str(dates[3].date()), "end_date": str(dates[-3].date()),
        "snapshot_root": str(root), "snapshot_id": snapshot_id,
        "formula_checksum": "checksum-test",
    }, output)

    values = pd.read_parquet(output / "year=2024" / "data.parquet")
    assert result["backend"] == "cpu-pandas"
    assert result["rowCount"] == len(values)
    assert result["validValueCount"] > 0
    assert list(values.columns) == ["tradeDate", "instrumentKey", "factorValue"]
    assert values["factorValue"].notna().any()
