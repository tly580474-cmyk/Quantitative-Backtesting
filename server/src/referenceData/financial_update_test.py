from __future__ import annotations

import unittest
import io
import json
from contextlib import redirect_stdout, redirect_stderr
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from datetime import date, datetime
import financial_update

from financial_update import (
    carry_forward_publications,
    derive_metrics,
    fiscal_metadata,
    map_api_rows,
    normalize_date,
    result_status,
    sina_indicator_start_year,
    SinaHttpClient,
)


class FinancialUpdateTest(unittest.TestCase):
    def test_incremental_indicator_window_and_backfill(self) -> None:
        target = {"latest_fetched_at": datetime(2026, 8, 1)}
        self.assertEqual(sina_indicator_start_year(target, date(2026, 8, 10), False), "2025")
        self.assertEqual(sina_indicator_start_year(target, date(2026, 8, 10), True), "2010")
        self.assertEqual(sina_indicator_start_year({}, date(2026, 8, 10), False), "2010")
        self.assertEqual(sina_indicator_start_year({"latest_fetched_at": "2023-01-01"}, date(2026, 8, 10), False), "2022")
        self.assertEqual(sina_indicator_start_year({"latest_fetched_at": "2026-08-31", "retry_indicator_start_year": "2010"}, date(2026, 8, 31), False), "2010")

    def test_sina_requests_have_bounded_timeout_and_retries(self) -> None:
        import requests
        response = MagicMock()
        with patch('requests.get', side_effect=[requests.Timeout('slow'), response]) as get, patch('financial_update.time.sleep'):
            self.assertIs(SinaHttpClient(0).get('https://example.invalid'), response)
            self.assertEqual(get.call_count, 2)
            self.assertEqual(get.call_args.kwargs['timeout'], (10, 30))
            response.raise_for_status.assert_called_once()
        with patch('requests.get', side_effect=requests.ConnectionError('offline')) as get, patch('financial_update.time.sleep'):
            with self.assertRaises(requests.ConnectionError):
                SinaHttpClient(0).get('https://example.invalid')
            self.assertEqual(get.call_count, 3)

    def test_commits_success_before_later_failure_and_returns_nonzero(self) -> None:
        args = SimpleNamespace(end_date='2026-08-31', start_date=None, lookback_days=21,
                               provider='sina', symbol=None, full=False, batch_size=2,
                               workers=1, dry_run=False, request_interval=0)
        targets = [{'instrument_key': 1, 'symbol': '000001'}, {'instrument_key': 2, 'symbol': '000002'}]
        record = {'instrument_key': 1, 'report_period': '2026-06-30', 'announcement_date': '2026-08-20'}
        good, bad = MagicMock(), MagicMock()
        good.result.return_value = [record]
        executor = MagicMock()
        executor.__enter__.return_value.submit.side_effect = [good, bad]
        output = io.StringIO()
        with patch.object(financial_update, 'parse_args', return_value=args), \
             patch.object(financial_update, 'load_env'), \
             patch.object(financial_update, 'connect_db', return_value=MagicMock()), \
             patch.object(financial_update, 'acquire_financial_lock'), \
             patch.object(financial_update, 'load_sina_retries', return_value={}), \
             patch.object(financial_update, 'save_sina_retries'), \
             patch.object(financial_update, 'configure_sina_runtime'), \
             patch.object(financial_update, 'load_sina_targets', return_value=targets), \
             patch.object(financial_update, 'ThreadPoolExecutor', return_value=executor), \
             patch.object(financial_update, 'as_completed', side_effect=lambda futures: list(futures)), \
             patch.object(financial_update, 'upsert_records', return_value=1) as write, \
             patch.object(financial_update, 'fill_calculated_roe', return_value=0), \
             redirect_stdout(output), redirect_stderr(io.StringIO()):
            def fail_after_commit():
                write.assert_called_once()
                raise TimeoutError('Sina timed out')
            bad.result.side_effect = fail_after_commit
            self.assertEqual(financial_update.main(), 1)
        updates = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(updates[0]['totalSymbols'], 2)
        self.assertEqual(updates[1]['writtenReports'], 1)
        self.assertEqual(updates[-1]['status'], 'partial')
        self.assertEqual(updates[-1]['apiRows']['failedSymbols'], 1)
        self.assertEqual(updates[-1]['failures'][0]['symbol'], '000002')

    def test_result_status_preserves_partial_failures(self) -> None:
        self.assertEqual(result_status(False, 0), "completed")
        self.assertEqual(result_status(False, 2), "partial")
        self.assertEqual(result_status(True, 2), "dry-run")

    def test_partial_records_commit_and_keep_retry_window(self) -> None:
        args = SimpleNamespace(end_date='2026-08-31', start_date=None, lookback_days=21,
                               provider='sina', symbol='000001', full=False, batch_size=1,
                               workers=1, dry_run=False, request_interval=0)
        target = {'instrument_key': 1, 'symbol': '000001', 'latest_fetched_at': '2026-08-31'}
        row = {'instrument_key': 1, 'report_period': '2026-06-30', 'announcement_date': '2026-08-20'}
        future, executor = MagicMock(), MagicMock()
        future.result.return_value = financial_update.FinancialRecords([row], [{'stage': 'indicators', 'error': 'offline'}])
        executor.__enter__.return_value.submit.return_value = future
        output = io.StringIO()
        with patch.object(financial_update, 'parse_args', return_value=args), \
             patch.object(financial_update, 'load_env'), \
             patch.object(financial_update, 'connect_db', return_value=MagicMock()), \
             patch.object(financial_update, 'acquire_financial_lock'), \
             patch.object(financial_update, 'configure_sina_runtime'), \
             patch.object(financial_update, 'load_sina_targets', return_value=[target]), \
             patch.object(financial_update, 'load_sina_retries', return_value={'000001': [{'indicatorStartYear': '2010'}]}), \
             patch.object(financial_update, 'save_sina_retries') as save, \
             patch.object(financial_update, 'ThreadPoolExecutor', return_value=executor), \
             patch.object(financial_update, 'as_completed', side_effect=lambda futures: list(futures)), \
             patch.object(financial_update, 'upsert_records', return_value=1) as write, \
             redirect_stdout(output):
            self.assertEqual(financial_update.main(), 1)
        write.assert_called_once()
        self.assertEqual(save.call_args.args[0]['000001'][0]['indicatorStartYear'], '2010')
        result = json.loads(output.getvalue().splitlines()[-1])
        self.assertEqual(result['status'], 'partial')
        self.assertEqual(result['writtenReports'], 1)
        self.assertEqual(result['apiRows']['partialSymbols'], 1)

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

    def test_indicator_failure_preserves_statements_and_bank_aliases(self) -> None:
        import pandas as pd
        rows = [
            pd.DataFrame([{"报告日": "2026-06-30", "公告日期": "2026-08-15", "营业收入": 100,
                           "归属于母公司的净利润": 0, "净利润": 7}]),
            pd.DataFrame([{"报告日": "2026-06-30", "公告日期": "2026-08-15", "资产总计": 200,
                           "股东权益合计": 80, "归属于母公司股东的权益": 70}]),
            pd.DataFrame([{"报告日": "2026-06-30", "公告日期": "2026-08-15", "经营活动产生的现金流量净额": 10}]),
        ]
        with patch('akshare.stock_financial_report_sina', side_effect=rows), \
             patch('akshare.stock_financial_analysis_indicator', side_effect=TimeoutError('indicator down')):
            result = financial_update.fetch_sina_symbol({'symbol': '000001', 'market': 'SZ', 'instrument_key': 1})
        self.assertEqual(len(result), 1)
        self.assertEqual(result.issues[0]['stage'], 'indicators')
        self.assertEqual(result[0]['net_operating_cash_flow'], 10)
        self.assertEqual(result[0]['equity_parent'], 70)
        self.assertEqual(result[0]['total_equity'], 80)
        derive_metrics(result[0])
        self.assertEqual(result[0]['net_margin_pct'], 0)  # Zero parent profit is not missing.

    def test_failed_statement_does_not_skip_later_statements(self) -> None:
        import pandas as pd
        balance = pd.DataFrame([{'报告日': '2026-06-30', '公告日期': '2026-08-15', '资产总计': 200}])
        cash = pd.DataFrame([{'报告日': '2026-06-30', '公告日期': '2026-08-15', '经营活动产生的现金流量净额': 5}])
        with patch('akshare.stock_financial_report_sina', side_effect=[TimeoutError('income'), balance, cash]), \
             patch('akshare.stock_financial_analysis_indicator', return_value=pd.DataFrame()):
            result = financial_update.fetch_sina_symbol({'symbol': '000001', 'market': 'SZ', 'instrument_key': 1})
        self.assertEqual(result[0]['total_assets'], 200)
        self.assertEqual(result[0]['net_operating_cash_flow'], 5)
        self.assertEqual([issue['stage'] for issue in result.issues], ['income', 'indicators'])

    def test_merge_preserves_old_fields_and_labels_mixed_source(self) -> None:
        incoming = {'source_key': 'eastmoney', 'net_profit_parent': 0, 'revenue': 100}
        financial_update.merge_existing_record(incoming, {'source_key': 'sina', 'net_profit_parent': 9,
                                                         'revenue': 99, 'asset_turnover': .4})
        self.assertEqual(incoming['net_profit_parent'], 0)
        self.assertEqual(incoming['revenue'], 100)
        self.assertEqual(incoming['asset_turnover'], .4)
        self.assertEqual(incoming['source_key'], 'eastmoney+sina')

    def test_later_write_failure_reports_already_committed_batches(self) -> None:
        connection = MagicMock()
        with patch.object(financial_update, '_upsert_batch', side_effect=[100, RuntimeError('write failed')]):
            with self.assertRaises(financial_update.PartialWriteError) as failure:
                financial_update.upsert_records(connection, [{} for _ in range(120)])
        self.assertEqual(failure.exception.written_reports, 100)
        connection.rollback.assert_called_once()

    def test_calculated_roe_uses_only_annual_versions_known_at_notice(self) -> None:
        connection = MagicMock()
        connection.cursor.return_value.__enter__.return_value.fetchall.return_value = [
            {'instrument_key': 1, 'report_period': date(2025, 12, 31), 'announcement_date': date(2026, 4, 1), 'equity_parent': 80},
            {'instrument_key': 1, 'report_period': date(2025, 12, 31), 'announcement_date': date(2026, 9, 1), 'equity_parent': 500},
        ]
        row = {'instrument_key': 1, 'announcement_date': '2026-08-01', 'fiscal_year': 2026,
               'fiscal_quarter': 2, 'net_profit_parent': 9, 'equity_parent': 100}
        self.assertEqual(financial_update.fill_calculated_roe(connection, [row]), 1)
        self.assertEqual(row['roe_calculated_pct'], 20)
        connection.commit.assert_not_called()
        for call in connection.cursor.return_value.__enter__.return_value.execute.call_args_list:
            self.assertNotIn('UPDATE', call.args[0])

    def test_later_values_do_not_leak_into_earlier_publication(self) -> None:
        rows = [{'instrument_key': 1, 'report_period': '2026-06-30', 'announcement_date': '2026-08-01', 'revenue': 10},
                {'instrument_key': 1, 'report_period': '2026-06-30', 'announcement_date': '2026-08-15', 'total_assets': 20}]
        carry_forward_publications(rows)
        self.assertIsNone(rows[0].get('total_assets'))
        self.assertEqual(rows[1]['revenue'], 10)


if __name__ == "__main__":
    unittest.main()
