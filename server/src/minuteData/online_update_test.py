from __future__ import annotations

import unittest

from online_update import (
    normalize_symbol,
    normalize_online_minutes,
    parse_sina_payload,
    reconcile_online_daily,
    sina_symbol,
)
from tdx_import import DailyReference
from update import normalize_symbol_minutes


class OnlineMinuteUpdateTest(unittest.TestCase):
    def test_maps_sina_market_symbols(self) -> None:
        self.assertEqual(sina_symbol("600519", "SH"), "sh600519")
        self.assertEqual(sina_symbol("002155", "SZ"), "sz002155")
        self.assertEqual(sina_symbol("920992", "BJ"), "bj920992")

    def test_infers_exchange_suffix(self) -> None:
        self.assertEqual(normalize_symbol("600519"), ("600519", "SH"))
        self.assertEqual(normalize_symbol("002155"), ("002155", "SZ"))
        self.assertEqual(normalize_symbol("920992"), ("920992", "BJ"))

    def test_parses_lot_volume_to_shares(self) -> None:
        payload = {"result": {"status": {"code": 0}, "data": [
            {"day": "2026-07-15 09:31:00", "open": "22.95", "high": "23.09",
             "low": "22.67", "close": "22.82", "volume": "2921200", "amount": "66864328"},
        ]}}
        result = parse_sina_payload(payload, "002155", "SZ")
        frame = result.frames["2026-07-15"]
        self.assertEqual(len(frame), 1)
        self.assertEqual(float(frame.iloc[0]["vol"]), 2_921_200)
        self.assertEqual(float(frame.iloc[0]["amount"]), 66_864_328)

    def test_reconciles_with_bounded_source_rounding(self) -> None:
        payload = {"result": {"data": [
            {"day": "2026-07-15 09:31:00", "open": 10, "high": 10, "low": 10,
             "close": 10, "volume": 10_000, "amount": 100_000},
        ]}}
        raw = parse_sina_payload(payload, "002155", "SZ").frames["2026-07-15"]
        frame = normalize_symbol_minutes("002155.SZ", "2026-07-15", raw, 10)
        reference = DailyReference(10, 10, 10, 10, 10, 10_050, 100_100)
        self.assertTrue(reconcile_online_daily("002155.SZ", frame, reference))

    def test_normalizes_sparse_source_to_native_240_bar_axis(self) -> None:
        payload = {"result": {"data": [
            {"day": "2026-07-15 09:31:00", "open": 10, "high": 10, "low": 10,
             "close": 10, "volume": 10_000, "amount": 100_000},
            {"day": "2026-07-15 15:00:00", "open": 10.1, "high": 10.1, "low": 10.1,
             "close": 10.1, "volume": 20_000, "amount": 202_000},
        ]}}
        raw = parse_sina_payload(payload, "002155", "SZ").frames["2026-07-15"]
        frame = normalize_online_minutes("002155.SZ", "2026-07-15", raw, 9.9)
        self.assertEqual(len(frame), 240)
        self.assertEqual(frame.iloc[0]["trade_time"], "2026-07-15 09:31:00")
        self.assertEqual(frame.iloc[-1]["trade_time"], "2026-07-15 15:00:00")
        self.assertEqual(float(frame.loc[frame["trade_time"] == "2026-07-15 14:59:00", "vol"].iloc[0]), 0)


if __name__ == "__main__":
    unittest.main()
