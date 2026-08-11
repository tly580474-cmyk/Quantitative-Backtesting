import unittest
from datetime import datetime
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from update import akshare_record, infer_market, tinyshare_record, write_progress


class FundFlowTransformTests(unittest.TestCase):
    def test_tinyshare_derives_main_from_large_and_extra_large(self):
        record = tinyshare_record({
            "trade_date": "20260810",
            "buy_sm_amount": 10, "sell_sm_amount": 7,
            "buy_md_amount": 20, "sell_md_amount": 11,
            "buy_lg_amount": 30, "sell_lg_amount": 13,
            "buy_elg_amount": 40, "sell_elg_amount": 17,
            "net_mf_amount": 8,
        }, 42, datetime(2026, 8, 10))
        self.assertEqual(record["small_net_in"], 30_000)
        self.assertEqual(record["medium_net_in"], 90_000)
        self.assertEqual(record["large_net_in"], 170_000)
        self.assertEqual(record["super_large_net_in"], 230_000)
        self.assertEqual(record["main_net_in"], 400_000)
        self.assertEqual(record["provider_net_in"], 80_000)

    def test_akshare_uses_rank_column_order(self):
        row = [1, "000001", "name", 12.5, 1.2, 100, 2, 60, 1.2, 40, .8, -30, -.6, -70, -1.4]
        record = akshare_record(row, 7, "2026-08-10", datetime(2026, 8, 10))
        self.assertEqual(record["main_net_in"], 100)
        self.assertEqual(record["super_large_net_in"], 60)
        self.assertEqual(record["large_net_in"], 40)
        self.assertEqual(record["medium_net_in"], -30)
        self.assertEqual(record["small_net_in"], -70)

    def test_market_inference_includes_beijing(self):
        self.assertEqual(infer_market("600000"), "SH")
        self.assertEqual(infer_market("000001"), "SZ")
        self.assertEqual(infer_market("430047"), "BJ")

    def test_progress_write_retries_transient_windows_file_lock(self):
        with TemporaryDirectory() as directory:
            target = Path(directory) / "progress.json"
            original_replace = Path.replace
            attempts = 0

            def flaky_replace(source: Path, destination: Path):
                nonlocal attempts
                attempts += 1
                if attempts == 1:
                    raise PermissionError("file is being read")
                return original_replace(source, destination)

            with patch.object(Path, "replace", flaky_replace), patch("update.time.sleep"):
                write_progress(target, status="running", completed=1)

            self.assertEqual(attempts, 2)
            self.assertIn('"completed": 1', target.read_text(encoding="utf-8"))
            self.assertEqual(list(target.parent.glob("*.tmp")), [])


if __name__ == "__main__":
    unittest.main()
