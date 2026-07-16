from __future__ import annotations

import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

import pandas as pd

from index_constituents_update import (
    discover_archive_files,
    normalize_csindex_batch,
    normalize_csindex_columns,
    parse_wayback_available,
    parse_wayback_cdx,
    parse_source_dates,
    validate_batch,
    wayback_source_urls,
)


class IndexConstituentUpdateTest(unittest.TestCase):
    def test_discovers_archived_constituent_and_weight_files(self) -> None:
        with TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "000300-202401-closeweight.xlsx").touch()
            (root / "000300-202401-cons.xls").touch()
            (root / "000905-ignored.xlsx").touch()
            specs = discover_archive_files(root, ["000300"])
            self.assertEqual(len(specs), 2)
            self.assertEqual([item.weighted for item in specs], [True, False])

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

    def test_parses_wayback_cdx_and_keeps_provenance(self) -> None:
        payload = (
            b'[["timestamp","original","digest"],'
            b'["20180304090913","http://example/000300closeweight.xls","digest-a"]]'
        )
        captures = parse_wayback_cdx(payload)
        self.assertEqual(len(captures), 1)
        self.assertEqual(captures[0].timestamp, "20180304090913")
        self.assertEqual(captures[0].digest, "digest-a")

    def test_wayback_urls_cover_old_and_current_official_hosts(self) -> None:
        urls = wayback_source_urls("000300")
        self.assertTrue(any("www.csindex.com.cn/uploads/" in url for url in urls))
        self.assertTrue(any("oss-ch.csindex.com.cn" in url for url in urls))
        self.assertTrue(all(url.endswith("000300closeweight.xls") for url in urls))

    def test_parses_wayback_availability_fallback(self) -> None:
        payload = (
            b'{"archived_snapshots":{"closest":{"available":true,'
            b'"timestamp":"20180304090913",'
            b'"url":"http://web.archive.org/web/20180304090913/'
            b'http://www.csindex.com.cn:80/file.xls"}}}'
        )
        capture = parse_wayback_available(payload, "http://www.csindex.com.cn/file.xls")
        self.assertIsNotNone(capture)
        assert capture is not None
        self.assertEqual(capture.timestamp, "20180304090913")
        self.assertEqual(capture.original_url, "http://www.csindex.com.cn:80/file.xls")

    def test_normalizes_historical_weight_file_without_exchange_english_name(self) -> None:
        frame = pd.DataFrame([[
            "2018-02-27", "000300", "沪深300", "CSI 300", "600000",
            "浦发银行", "SPDB", "SHH", 1.26,
        ]])
        normalized = normalize_csindex_columns(frame, "historical", True)
        self.assertEqual(normalized.iloc[0]["权重"], 1.26)
        self.assertIsNone(normalized.iloc[0]["交易所英文名称"])


if __name__ == "__main__":
    unittest.main()
