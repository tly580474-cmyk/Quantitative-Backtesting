from __future__ import annotations

import unittest
from datetime import datetime

import pandas as pd

from update import (
    build_plan,
    expected_trade_times,
    latest_finalized_date,
    normalize_symbol_minutes,
    universe_for_date,
)


class MinuteUpdateTest(unittest.TestCase):
    def test_builds_gap_plan_from_manifest(self) -> None:
        manifest = {"files": [
            {"date": "2026-04-09"},
            {"date": "2026-04-10"},
        ]}
        plan = build_plan(manifest, None, "2026-04-13")
        self.assertEqual(plan.manifest_last_date, "2026-04-10")
        self.assertEqual(plan.start_date, "2026-04-11")
        self.assertEqual(plan.end_date, "2026-04-13")

    def test_excludes_unfinalized_current_day(self) -> None:
        before_close = datetime.fromisoformat("2026-07-15T15:09:00+08:00")
        after_close = datetime.fromisoformat("2026-07-15T15:10:00+08:00")
        self.assertEqual(latest_finalized_date(before_close), "2026-07-14")
        self.assertEqual(latest_finalized_date(after_close), "2026-07-15")

    def test_uses_the_same_241_minute_time_axis_as_the_lake(self) -> None:
        values = expected_trade_times("2026-04-10")
        self.assertEqual(len(values), 241)
        self.assertEqual(values[0], "2026-04-10 09:30:00")
        self.assertEqual(values[120], "2026-04-10 11:30:00")
        self.assertEqual(values[121], "2026-04-10 13:01:00")
        self.assertEqual(values[-1], "2026-04-10 15:00:00")

    def test_fills_zero_volume_minutes_without_changing_real_bars(self) -> None:
        raw = pd.DataFrame([
            {
                "ts_code": "002155.SZ", "trade_time": "2026-04-10 09:30:00",
                "open": 16.0, "high": 16.1, "low": 15.9, "close": 16.05,
                "vol": 1000.0, "amount": 16050.0,
            },
            {
                "ts_code": "002155.SZ", "trade_time": "2026-04-10 09:32:00",
                "open": 16.05, "high": 16.2, "low": 16.0, "close": 16.1,
                "vol": 800.0, "amount": 12880.0,
            },
        ])
        result = normalize_symbol_minutes("002155.SZ", "2026-04-10", raw, 15.8)
        self.assertEqual(len(result), 241)
        filled = result.iloc[1]
        self.assertEqual(filled["trade_time"], "2026-04-10 09:31:00")
        self.assertEqual(filled["open"], 16.05)
        self.assertEqual(filled["close"], 16.05)
        self.assertEqual(filled["vol"], 0)
        self.assertAlmostEqual(result.iloc[0]["pre_close"], 15.8)
        self.assertAlmostEqual(result.iloc[0]["change"], 0.25)
        self.assertAlmostEqual(result.iloc[1]["pre_close"], 16.05)
        self.assertAlmostEqual(result.iloc[2]["pre_close"], 16.05)
        self.assertAlmostEqual(result.iloc[2]["change"], 0.05)

    def test_filters_historical_stock_universe(self) -> None:
        frame = pd.DataFrame([
            {"ts_code": "000001.SZ", "list_date": "19910403", "delist_date": ""},
            {"ts_code": "600001.SH", "list_date": "19900101", "delist_date": "20260409"},
            {"ts_code": "920001.BJ", "list_date": "20260410", "delist_date": ""},
        ])
        self.assertEqual(
            universe_for_date(frame, "2026-04-10"),
            ["000001.SZ", "920001.BJ"],
        )


if __name__ == "__main__":
    unittest.main()
