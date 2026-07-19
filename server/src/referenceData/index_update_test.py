from __future__ import annotations

import unittest

import pandas as pd

from index_update import TARGETS, apply_previous_close, canonical_checksum, validate_index_frame


class IndexUpdateTest(unittest.TestCase):
    def test_supports_csi_all_share(self) -> None:
        self.assertEqual(TARGETS["000985"].provider_symbol, "000985")
        self.assertEqual(TARGETS["000985"].source_file_name, "csindex:index-perf")

    def test_accepts_valid_ohlcv(self) -> None:
        frame = pd.DataFrame([{
            "tradeDate": "2026-07-15",
            "open": 10.0,
            "high": 11.0,
            "low": 9.5,
            "close": 10.5,
            "volume": 100.0,
            "amount": 1000.0,
        }])
        validate_index_frame(frame, "000300")

    def test_rejects_invalid_high(self) -> None:
        frame = pd.DataFrame([{
            "tradeDate": "2026-07-15",
            "open": 10.0,
            "high": 9.0,
            "low": 8.0,
            "close": 10.5,
            "volume": 100.0,
            "amount": 1000.0,
        }])
        with self.assertRaisesRegex(RuntimeError, "invalid highs"):
            validate_index_frame(frame, "000300")

    def test_checksum_is_order_sensitive_and_repeatable(self) -> None:
        rows = [("2026-07-14", 1.0), ("2026-07-15", 2.0)]
        self.assertEqual(canonical_checksum(rows), canonical_checksum(rows))
        self.assertNotEqual(canonical_checksum(rows), canonical_checksum(list(reversed(rows))))

    def test_applies_previous_close_to_incremental_first_row(self) -> None:
        frame = pd.DataFrame([{
            "tradeDate": "2026-07-16",
            "close": 99.0,
            "change": None,
            "changePercent": None,
        }])
        result = apply_previous_close(frame, 100.0)
        self.assertEqual(result.iloc[0]["change"], -1.0)
        self.assertEqual(result.iloc[0]["changePercent"], -1.0)

    def test_keeps_first_return_missing_without_previous_close(self) -> None:
        frame = pd.DataFrame([{
            "tradeDate": "2026-07-16",
            "close": 99.0,
            "change": None,
            "changePercent": None,
        }])
        result = apply_previous_close(frame, None)
        self.assertIsNone(result.iloc[0]["change"])


if __name__ == "__main__":
    unittest.main()
