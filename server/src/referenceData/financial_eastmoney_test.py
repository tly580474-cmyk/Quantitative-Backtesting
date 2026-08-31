from __future__ import annotations

import tempfile
import unittest
from datetime import date
from pathlib import Path
from unittest.mock import MagicMock

import financial_eastmoney as em


class EastmoneyTest(unittest.TestCase):
    def test_periods_at_quarter_and_year_boundaries(self):
        self.assertEqual(em.recent_periods(date(2026, 8, 31)), ['2026-06-30', '2026-03-31'])
        self.assertEqual(em.recent_periods(date(2026, 4, 1)), ['2026-03-31', '2025-12-31'])
        self.assertEqual(em.recent_periods(date(2026, 6, 30)), ['2026-03-31', '2025-12-31'])

    def test_currency_notice_universe_and_equity_semantics(self):
        row = {'SECURITY_CODE': '920288', 'REPORT_DATE': '2026-06-30', 'NOTICE_DATE': '2026-08-28',
               'CURRENCY': 'CNY', 'TOTAL_EQUITY': 100, 'TOTAL_PARENT_EQUITY': 80}
        records = {}
        em.map_rows(records, [row, {**row, 'NOTICE_DATE': '2026-09-01', 'TOTAL_EQUITY': 500},
                             {**row, 'CURRENCY': 'USD', 'TOTAL_EQUITY': 1}, {**row, 'SECURITY_CODE': '920289'}],
                    'BALANCE', {'920288': 1}, '2026-06-30', '2026-08-31')
        self.assertEqual(len(records), 1)
        self.assertEqual(records[(1, '2026-06-30', '2026-08-28')]['total_equity'], 100)
        self.assertEqual(records[(1, '2026-06-30', '2026-08-28')]['equity_parent'], 80)

    def test_repeated_page_rejected_and_not_cached(self):
        with tempfile.TemporaryDirectory() as directory:
            client = em.EastmoneyClient(Path(directory), interval=0)
            client.request = MagicMock(return_value={'count': 2, 'pages': 2, 'data': [{'SECURITY_CODE': '000001'}]})
            with self.assertRaisesRegex(ValueError, 'repeated'):
                client.fetch('RPT_LICO_FN_CPD', '2026-06-30')
            self.assertFalse((Path(directory) / '2026-06-30/RPT_LICO_FN_CPD.json').exists())

    def test_changed_total_rejected_and_successful_stage_resumes(self):
        with tempfile.TemporaryDirectory() as directory:
            client = em.EastmoneyClient(Path(directory), interval=0)
            client.request = MagicMock(side_effect=[{'count': 2, 'pages': 2, 'data': [{'SECURITY_CODE': '1'}]},
                                                   {'count': 3, 'pages': 2, 'data': [{'SECURITY_CODE': '2'}]}])
            with self.assertRaisesRegex(ValueError, 'changed'):
                client.fetch('RPT_LICO_FN_CPD', '2026-06-30')
            client.request = MagicMock(return_value={'count': 1, 'pages': 1, 'data': [{'SECURITY_CODE': '1'}]})
            first = client.fetch('RPT_LICO_FN_CPD', '2026-06-30')
            client.resume = True
            client.request = MagicMock(side_effect=AssertionError('should use cache'))
            self.assertEqual(client.fetch('RPT_LICO_FN_CPD', '2026-06-30'), first)

    def test_failed_template_keeps_usable_records_but_is_partial(self):
        disclosure = {'SECURITY_CODE': '000001', 'REPORTDATE': '2026-06-30', 'NOTICE_DATE': '2026-08-15',
                      'TOTAL_OPERATE_INCOME': 100, 'PARENT_NETPROFIT': 0, 'WEIGHTAVG_ROE': 0}
        balance = {**disclosure, 'REPORT_DATE': '2026-06-30', 'TOTAL_ASSETS': 200, 'TOTAL_LIABILITIES': 120,
                   'TOTAL_EQUITY': 80, 'TOTAL_PARENT_EQUITY': 75}
        cash = {**balance, 'NETCASH_OPERATE': 0}
        def fetch(report, *_args):
            if report == 'RPT_LICO_FN_CPD': return [disclosure]
            if report == 'RPT_F10_FINANCE_GINCOME': raise TimeoutError('offline')
            if 'BALANCE' in report: return [balance]
            if 'CASHFLOW' in report: return [cash]
            return []
        client = MagicMock()
        client.fetch.side_effect = fetch
        rows, detail = em.collect_period(client, {'000001': 1, '002731': 2}, '2026-06-30', '2026-08-31')
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['net_profit_parent'], 0)
        self.assertEqual(rows[0]['roe_weighted_pct'], 0)
        self.assertEqual(detail['incomplete'], [])
        self.assertEqual(detail['undisclosedSymbols'], ['002731'])
        self.assertEqual(len(detail['failures']), 1)


if __name__ == '__main__':
    unittest.main()
