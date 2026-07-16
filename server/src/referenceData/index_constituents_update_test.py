from __future__ import annotations

import unittest

import pandas as pd

from index_constituents_update import normalize_csindex_batch, parse_source_dates, validate_batch


class IndexConstituentUpdateTest(unittest.TestCase):
    def test_keeps_constituent_and_weight_dates_explicit(self) -> None:
        frame = pd.DataFrame([{
            "日期": "2026-06-30",
            "指数代码": "000300",
            "指数名称": "沪深300",
            "成分券代码": "000001",
            "成分券名称": "平安银行",
            "交易所": "深圳证券交易所",
            "权重": 100.0,
        }])
        batch = normalize_csindex_batch(frame, "000300", "weight-source", True)
        self.assertEqual(batch.constituent_date, "2026-06-30")
        self.assertEqual(batch.weight_date, "2026-06-30")
        self.assertEqual(batch.members[0].code, "000001")
        validate_batch(batch)

    def test_unweighted_snapshot_does_not_fabricate_weights(self) -> None:
        frame = pd.DataFrame([{
            "日期": "2026-07-15",
            "指数代码": "000300",
            "指数名称": "沪深300",
            "成分券代码": "1",
            "成分券名称": "平安银行",
        }])
        batch = normalize_csindex_batch(frame, "000300", "constituent-source", False)
        self.assertIsNone(batch.weight_date)
        self.assertIsNone(batch.members[0].weight_pct)
        self.assertEqual(batch.members[0].code, "000001")

    def test_parses_compact_numeric_source_dates(self) -> None:
        parsed = parse_source_dates(pd.Series([20260715, "2026-06-30"]))
        self.assertEqual(parsed.dt.strftime("%Y-%m-%d").tolist(), ["2026-07-15", "2026-06-30"])


if __name__ == "__main__":
    unittest.main()
