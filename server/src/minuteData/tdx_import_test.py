from __future__ import annotations

import unittest
from pathlib import Path

import pandas as pd

from tdx_import import (
    classify_idle_status,
    DailyReference,
    Instrument,
    normalize_instrument_minutes,
    tdx_path,
)


def sample_raw() -> pd.DataFrame:
    times = list(pd.date_range("2026-04-13 09:31", "2026-04-13 11:30", freq="min"))
    times += list(pd.date_range("2026-04-13 13:01", "2026-04-13 15:00", freq="min"))
    values = pd.Series(range(240), dtype="float64") / 1000 + 16.0
    return pd.DataFrame({
        "open": values.values,
        "high": values.values + 0.01,
        "low": values.values - 0.01,
        "close": values.values,
        "volume": 100.0,
        "amount": values.values * 100.0,
    }, index=pd.DatetimeIndex(times, name="date"))


class TdxMinuteImportTest(unittest.TestCase):
    def setUp(self) -> None:
        self.instrument = Instrument("002155", "SZ", "20070816", None)
        raw = sample_raw()
        self.reference = DailyReference(
            previous_close=15.8,
            open=float(raw.iloc[0]["open"]),
            high=float(raw["high"].max()),
            low=float(raw["low"].min()),
            close=float(raw.iloc[-1]["close"]),
            volume=float(raw["volume"].sum()),
            amount=float(raw["amount"].sum()),
        )

    def test_maps_market_to_lc1_path_including_beijing(self) -> None:
        root = Path("D:/tdx")
        self.assertEqual(
            tdx_path(root, Instrument("920992", "BJ", None, None)),
            root / "vipdoc/bj/minline/bj920992.lc1",
        )

    def test_reports_stale_source_only_when_a_new_trading_day_is_expected(self) -> None:
        self.assertEqual(classify_idle_status("2026-07-15", "2026-07-16"), "source-stale")
        self.assertEqual(classify_idle_status("2026-07-17", "2026-07-17"), "up-to-date")
        self.assertEqual(classify_idle_status("2026-07-20", "2026-07-17"), "up-to-date")

    def test_normalizes_native_240_bar_time_axis(self) -> None:
        groups = normalize_instrument_minutes(
            self.instrument,
            sample_raw(),
            {("002155.SZ", "2026-04-13"): self.reference},
            "2026-04-13",
            "2026-04-13",
        )
        self.assertEqual(len(groups), 1)
        trade_date, frame = groups[0]
        self.assertEqual(trade_date, "2026-04-13")
        self.assertEqual(len(frame), 240)
        self.assertEqual(frame.iloc[0]["trade_time"], "2026-04-13 09:31:00")
        self.assertEqual(frame.iloc[-1]["trade_time"], "2026-04-13 15:00:00")
        self.assertAlmostEqual(float(frame.iloc[0]["pre_close"]), 15.8)
        self.assertAlmostEqual(float(frame.iloc[1]["pre_close"]), 16.0)

    def test_rejects_daily_mismatch(self) -> None:
        bad = DailyReference(**{**self.reference.__dict__, "close": 99.0})
        with self.assertRaisesRegex(RuntimeError, "close=False"):
            normalize_instrument_minutes(
                self.instrument,
                sample_raw(),
                {("002155.SZ", "2026-04-13"): bad},
                "2026-04-13",
                "2026-04-13",
            )

    def test_marks_daily_volume_or_amount_unit_mismatch_unverified(self) -> None:
        bad = DailyReference(**{**self.reference.__dict__, "volume": 1.0})
        groups = normalize_instrument_minutes(
            self.instrument,
            sample_raw(),
            {("002155.SZ", "2026-04-13"): bad},
            "2026-04-13",
            "2026-04-13",
        )
        self.assertFalse(groups[0][1].attrs["daily_verified"])

    def test_accepts_known_star_market_daily_volume_multiplier(self) -> None:
        instrument = Instrument("688001", "SH", "20190722", None)
        reference = DailyReference(**{
            **self.reference.__dict__,
            "volume": self.reference.volume * 100 - 1_500,
        })
        groups = normalize_instrument_minutes(
            instrument,
            sample_raw(),
            {("688001.SH", "2026-04-13"): reference},
            "2026-04-13",
            "2026-04-13",
        )
        self.assertEqual(len(groups), 1)
        self.assertEqual(float(groups[0][1]["vol"].sum()), self.reference.volume)

    def test_skips_zero_volume_suspension_without_daily_reference(self) -> None:
        raw = sample_raw()
        raw[["open", "high", "low", "close"]] = 7.23
        raw[["volume", "amount"]] = 0
        groups = normalize_instrument_minutes(
            self.instrument, raw, {}, "2026-04-13", "2026-04-13",
        )
        self.assertEqual(groups, [])

    def test_keeps_traded_minutes_when_daily_reference_is_missing(self) -> None:
        groups = normalize_instrument_minutes(
            self.instrument, sample_raw(), {}, "2026-04-13", "2026-04-13",
        )
        self.assertEqual(len(groups), 1)
        self.assertFalse(groups[0][1].attrs["daily_verified"])
        self.assertAlmostEqual(float(groups[0][1].iloc[0]["pre_close"]), 16.0)


if __name__ == "__main__":
    unittest.main()
