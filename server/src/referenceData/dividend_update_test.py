from __future__ import annotations

import unittest

import pandas as pd

from dividend_update import (
    completion_status,
    Instrument,
    classify_failure,
    normalize_dividend_events,
    per_ten_to_per_share,
)


class DividendUpdateTest(unittest.TestCase):
    def test_completion_status_distinguishes_confirmed_empty_history(self):
        self.assertEqual(completion_status([]), "no_data")
        self.assertEqual(completion_status([{"event_id": "one"}]), "completed")

    def test_repeated_source_no_detail_becomes_explicit_no_data(self):
        instrument = Instrument(1, "000001", "active")
        error = "'NoneType' object is not subscriptable"
        self.assertEqual(classify_failure(instrument, 1, error), "failed")
        self.assertEqual(classify_failure(instrument, 2, error), "no_data")

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

    def test_marks_repeat_delisted_no_data_as_terminal(self) -> None:
        instrument = Instrument(1, "000003", "delisted")
        self.assertEqual(
            classify_failure(instrument, 2, "'NoneType' object is not subscriptable"),
            "no_data",
        )

    def test_confirms_active_source_no_detail_as_no_data_after_retry(self) -> None:
        instrument = Instrument(1, "688981", "active")
        self.assertEqual(
            classify_failure(instrument, 5, "'NoneType' object is not subscriptable"),
            "no_data",
        )


if __name__ == "__main__":
    unittest.main()
