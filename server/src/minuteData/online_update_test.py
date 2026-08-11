from __future__ import annotations

import unittest
from unittest.mock import patch

from online_update import (
    AdaptiveRequestGate,
    OnlineResult,
    fetch_universe,
    normalize_symbol,
    normalize_online_minutes,
    parse_sina_payload,
    reconcile_online_daily,
    sina_symbol,
)
from tdx_import import DailyReference, Instrument
from update import normalize_symbol_minutes


class OnlineMinuteUpdateTest(unittest.TestCase):
    def test_shared_throttle_does_not_multiply_for_concurrent_workers(self) -> None:
        gate = AdaptiveRequestGate(requests_per_second=10, base_cooldown=60, max_cooldown=300)
        with patch("online_update.time.monotonic", return_value=100.0):
            first = gate.throttle()
            second = gate.throttle()
        self.assertEqual(first, 60)
        self.assertEqual(second, 60)
        self.assertEqual(gate.throttle_level, 1)

    def test_recovery_round_refetches_only_failed_symbols(self) -> None:
        instruments = [
            Instrument(symbol="000001", market="SZ", list_date=None, delist_date=None),
            Instrument(symbol="000002", market="SZ", list_date=None, delist_date=None),
        ]

        class RecoveringSource:
            def __init__(self) -> None:
                self.calls: dict[str, int] = {}

            def fetch(self, instrument: Instrument) -> OnlineResult:
                symbol = instrument.provider_symbol
                self.calls[symbol] = self.calls.get(symbol, 0) + 1
                if symbol == "000002.SZ" and self.calls[symbol] == 1:
                    raise RuntimeError("HTTP 456")
                return OnlineResult(instrument.symbol, instrument.market, None, {}, {})

        source = RecoveringSource()
        responses, errors = fetch_universe(source, instruments, workers=2, recovery_rounds=1)
        self.assertEqual(set(responses), {"000001.SZ", "000002.SZ"})
        self.assertEqual(errors, {})
        self.assertEqual(source.calls["000001.SZ"], 1)
        self.assertEqual(source.calls["000002.SZ"], 2)

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
