from __future__ import annotations

import unittest
from datetime import date

import pandas as pd

from dividend_current_update import default_periods, normalize_current_events
from dividend_update import Instrument


class DividendCurrentUpdateTest(unittest.TestCase):
    def test_selects_report_periods_available_by_month(self) -> None:
        self.assertEqual(
            default_periods(date(2026, 7, 16)),
            ["20251231", "20260331", "20260630"],
        )

    def test_normalizes_market_wide_row_to_per_share(self) -> None:
        frame = pd.DataFrame([{
            "代码": "002155",
            "现金分红-现金分红比例": 3.0,
            "现金分红-股息率": 0.02,
            "送转股份-送转比例": 0.0,
            "送转股份-转股比例": 1.0,
            "预案公告日": "2026-03-20",
            "除权除息日": "2026-06-11",
            "方案进度": "实施分配",
        }])
        events, unmapped = normalize_current_events(
            frame, {"002155": Instrument(1, "002155")}, "20251231"
        )
        self.assertEqual(unmapped, [])
        self.assertEqual(events[0]["report_period"], "2025-12-31")
        self.assertEqual(events[0]["cash_dividend_per_share"], 0.3)
        self.assertEqual(events[0]["transfer_share_per_share"], 0.1)


if __name__ == "__main__":
    unittest.main()
