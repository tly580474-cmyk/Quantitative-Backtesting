from __future__ import annotations

import tempfile
import unittest
from datetime import date, datetime, time, timedelta
from pathlib import Path

from tdx_import import DailyReference, Instrument
from tdx_online import (
    FetchResult,
    TdxCheckpoint,
    expected_tdx_times,
    fetch_bars_for_dates,
    normalize_tdx_bars,
    tdx_market,
)


def sample_bars(trade_date: str = "2026-08-26") -> list[dict]:
    rows = []
    for start, end in ((time(9, 31), time(11, 30)), (time(13, 1), time(15, 0))):
        cursor = datetime.combine(date.fromisoformat(trade_date), start)
        finish = datetime.combine(date.fromisoformat(trade_date), end)
        while cursor <= finish:
            rows.append({
                "datetime": cursor.strftime("%Y-%m-%d %H:%M"),
                "open": 10.0,
                "close": 10.0,
                "high": 10.0,
                "low": 10.0,
                "vol": 100.0,
                "amount": 1_000.0,
            })
            cursor += timedelta(minutes=1)
    return rows


class TdxOnlineTest(unittest.TestCase):
    def setUp(self) -> None:
        self.instrument = Instrument("000001", "SZ", None, None)
        self.reference = DailyReference(
            previous_close=9.9,
            open=10.0,
            high=10.0,
            low=10.0,
            close=10.0,
            volume=24_000.0,
            amount=240_000.0,
        )

    def test_maps_beijing_market(self) -> None:
        self.assertEqual(tdx_market("SZ"), 0)
        self.assertEqual(tdx_market("SH"), 1)
        self.assertEqual(tdx_market("BJ"), 2)

    def test_expected_axis_has_native_240_bars(self) -> None:
        values = expected_tdx_times("2026-08-26")
        self.assertEqual(len(values), 240)
        self.assertEqual(values[0], "2026-08-26 09:31:00")
        self.assertEqual(values[-1], "2026-08-26 15:00:00")

    def test_normalizes_complete_tdx_bars(self) -> None:
        frame = normalize_tdx_bars(
            self.instrument, "2026-08-26", sample_bars(), self.reference,
        )
        self.assertEqual(len(frame), 240)
        self.assertEqual(frame.iloc[0]["pre_close"], 9.9)
        self.assertEqual(frame.iloc[-1]["trade_time"], "2026-08-26 15:00:00")
        self.assertTrue(frame.attrs["daily_verified"])

    def test_normalizes_tdx_zero_denormal_sentinel(self) -> None:
        bars = sample_bars()
        bars[0]["vol"] = 5.877471754111438e-39
        bars[0]["amount"] = 5.877471754111438e-39
        reference = DailyReference(
            previous_close=9.9,
            open=10.0,
            high=10.0,
            low=10.0,
            close=10.0,
            volume=23_900.0,
            amount=239_000.0,
        )
        frame = normalize_tdx_bars(
            self.instrument, "2026-08-26", bars, reference,
        )
        self.assertEqual(frame.iloc[0]["vol"], 0.0)
        self.assertEqual(frame.iloc[0]["amount"], 0.0)
        self.assertTrue(frame.attrs["daily_verified"])

    def test_rejects_incomplete_axis(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "239"):
            normalize_tdx_bars(
                self.instrument, "2026-08-26", sample_bars()[:-1], self.reference,
            )

    def test_checkpoint_round_trip(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "checkpoint.sqlite3"
            checkpoint = TdxCheckpoint(path)
            try:
                checkpoint.put(FetchResult(
                    "000001.SZ", tuple(sample_bars()[:2]), "127.0.0.1:7709",
                ))
                loaded = checkpoint.load({"000001.SZ"})
            finally:
                checkpoint.close()
            self.assertEqual(loaded["000001.SZ"].server, "127.0.0.1:7709")
            self.assertEqual(len(loaded["000001.SZ"].bars), 2)

    def test_fetch_pages_until_requested_start_date(self) -> None:
        newest = sample_bars("2026-08-26")
        older = sample_bars("2026-08-25")

        class FakeApi:
            def get_security_bars(self, category, market, code, start, count):
                return newest if start == 0 else older if start == count else []

        result = fetch_bars_for_dates(
            FakeApi(), self.instrument, "2026-08-25", "2026-08-26",
            page_size=240, max_pages=3,
        )
        self.assertEqual(len(result), 480)
        self.assertTrue(result[0]["datetime"].startswith("2026-08-25"))


if __name__ == "__main__":
    unittest.main()
