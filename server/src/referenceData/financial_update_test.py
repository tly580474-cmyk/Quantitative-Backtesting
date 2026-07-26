from __future__ import annotations

import unittest

from datetime import datetime

from financial_update import (
    carry_forward_publications,
    derive_metrics,
    fiscal_metadata,
    map_api_rows,
    normalize_date,
    result_status,
)


class FinancialUpdateTest(unittest.TestCase):
    def test_result_status_preserves_partial_failures(self) -> None:
        self.assertEqual(result_status(False, 0), "completed")
        self.assertEqual(result_status(False, 2), "partial")
        self.assertEqual(result_status(True, 2), "dry-run")

    def test_normalize_date(self) -> None:
        self.assertEqual(normalize_date("20260726"), "2026-07-26")
        self.assertEqual(normalize_date("2026-07-26"), "2026-07-26")
        self.assertEqual(normalize_date(datetime(2026, 7, 26)), "2026-07-26")
        self.assertIsNone(normalize_date(""))

    def test_fiscal_metadata(self) -> None:
        self.assertEqual(fiscal_metadata("2025-12-31"), (2025, 4, "annual"))
        self.assertEqual(fiscal_metadata("2026-06-30"), (2026, 2, "quarterly"))

    def test_maps_tushare_financial_indicator(self) -> None:
        records = map_api_rows("fina_indicator", [{
            "ts_code": "000001.SZ",
            "ann_date": "20260420",
            "end_date": "20260331",
            "roe": 3.2,
            "grossprofit_margin": 41.5,
            "debt_to_assets": 88.0,
            "tr_yoy": 7.5,
        }], {"000001.SZ": 1})
        record = next(iter(records.values()))
        self.assertEqual(record["roe_pct"], 3.2)
        self.assertEqual(record["gross_margin_pct"], 41.5)
        self.assertEqual(record["debt_to_assets_pct"], 88.0)
        self.assertEqual(record["revenue_yoy_pct"], 7.5)

    def test_derives_missing_ratios_without_overwriting_source_values(self) -> None:
        record = {
            "revenue": 100.0,
            "operating_cost": 60.0,
            "net_profit_parent": 10.0,
            "total_assets": 200.0,
            "total_liabilities": 80.0,
            "net_operating_cash_flow": 15.0,
            "capital_expenditure": 4.0,
            "gross_margin_pct": None,
        }
        derive_metrics(record)
        self.assertEqual(record["gross_margin_pct"], 40.0)
        self.assertEqual(record["net_margin_pct"], 10.0)
        self.assertEqual(record["debt_to_assets_pct"], 40.0)
        self.assertEqual(record["operating_cash_flow_to_revenue_pct"], 15.0)
        self.assertEqual(record["free_cash_flow"], 11.0)

    def test_carries_earlier_statement_values_into_later_publication(self) -> None:
        rows = [
            {
                "instrument_key": 1, "report_period": "2025-12-31",
                "announcement_date": "2026-04-10", "revenue": 100.0,
            },
            {
                "instrument_key": 1, "report_period": "2025-12-31",
                "announcement_date": "2026-04-27", "total_assets": 200.0,
            },
        ]
        carry_forward_publications(rows)
        self.assertEqual(rows[1]["revenue"], 100.0)


if __name__ == "__main__":
    unittest.main()
