from __future__ import annotations

import unittest

import pandas as pd

from dividend_update import Instrument, normalize_dividend_events, per_ten_to_per_share


class DividendUpdateTest(unittest.TestCase):
    def test_converts_per_ten_share_ratios_to_per_share(self) -> None:
        self.assertEqual(per_ten_to_per_share(1.5), 0.15)

    def test_normalizes_event_without_fabricating_missing_dates(self) -> None:
        frame = pd.DataFrame([{
            "报告期": "2025-12-31",
            "现金分红-现金分红比例": 2.0,
            "送转股份-送股比例": 0.0,
            "送转股份-转股比例": 1.0,
            "现金分红-现金分红比例描述": "10派2元转1股",
            "除权除息日": None,
        }])
        events = normalize_dividend_events(frame, Instrument(1, "002155"))
        self.assertEqual(events[0]["cash_dividend_per_share"], 0.2)
        self.assertEqual(events[0]["transfer_share_per_share"], 0.1)
        self.assertIsNone(events[0]["ex_date"])


if __name__ == "__main__":
    unittest.main()
