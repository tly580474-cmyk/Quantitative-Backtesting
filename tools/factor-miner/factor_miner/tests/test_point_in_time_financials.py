import pandas as pd

from factor_miner.data.snapshot import _attach_point_in_time_financials


def test_financial_report_is_visible_only_on_and_after_announcement(tmp_path):
    dataset = tmp_path / "financial_reports"
    dataset.mkdir()
    pd.DataFrame([
        {"instrumentKey": 1, "reportPeriod": "2025-12-31",
         "announcementDate": "2026-03-20", "updateFlag": 0,
         "fetchedAt": "2026-03-20T12:00:00Z", "roePct": 10.0,
         "sourceVersion": "v1"},
        {"instrumentKey": 1, "reportPeriod": "2025-12-31",
         "announcementDate": "2026-04-10", "updateFlag": 1,
         "fetchedAt": "2026-04-10T12:00:00Z", "roePct": 12.0,
         "sourceVersion": "v2"},
    ]).to_parquet(dataset / "data.parquet", index=False)
    bars = pd.DataFrame([
        {"instrumentKey": 1, "tradeDate": "2026-03-19"},
        {"instrumentKey": 1, "tradeDate": "2026-03-20"},
        {"instrumentKey": 1, "tradeDate": "2026-04-11"},
    ])
    manifest = {"datasets": [{
        "name": "financial_reports", "relativePath": "financial_reports/data.parquet",
    }]}

    result = _attach_point_in_time_financials(bars, tmp_path, manifest)

    assert pd.isna(result.iloc[0]["roePct"])
    assert result.iloc[1]["roePct"] == 10.0
    assert result.iloc[2]["roePct"] == 12.0
    assert result.iloc[2]["sourceVersion"] == "v2"
