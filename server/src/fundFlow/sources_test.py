import unittest
from datetime import datetime
from unittest.mock import Mock, patch
from sources import WEB_SOURCE, WEB_TABLE, fetch_web_rows, web_record, gateway_record
from gap_backfill import prepare_rows
from update import Instrument, upsert_records


class SourceContracts(unittest.TestCase):
    def web(self, **extra):
        return dict(TRADE_DATE='2026-09-24',SECUCODE='600000.SH',PRIME_INFLOW=30,
                    SUPERDEAL_INFLOW=110,SUPERDEAL_OUTFLOW=100,BIGDEAL_INFLOW=50,
                    BIGDEAL_OUTFLOW=30,CLOSE_PRICE=10,CHANGE_RATE=1,**extra)

    def historical(self):
        return dict(trade_date='20260924',ts_code='600000.SH',close=10,pct_change=1,
                    net_amount=3,buy_elg_amount=1,buy_lg_amount=2,buy_md_amount=-1,buy_sm_amount=-2)

    def test_net_amounts_and_missing_fields_remain_source_specific(self):
        row=self.web(); row.update(CLOSE_PRICE=None,CHANGE_RATE=float('nan'),BUY_RATIO=55)
        r=web_record(row,1,'2026-09-24',datetime.now())
        self.assertEqual((r['main_net_in'],r['super_large_net_in'],r['large_net_in']),(30,10,20))
        self.assertEqual(r['source_key'],WEB_SOURCE)
        for field in ('medium_net_in','small_net_in','main_net_ratio','close_price','change_pct'):
            self.assertIsNone(r[field])

    def test_rejects_stale_date_unsupported_market_and_inconsistent_main(self):
        for change in (dict(TRADE_DATE='2026-09-23'),dict(SECUCODE='920001.BJ'),dict(PRIME_INFLOW=31),dict(PRIME_INFLOW=None)):
            with self.subTest(change=change), self.assertRaises(ValueError):
                web_record({**self.web(),**change},1,'2026-09-24',datetime.now())

    def test_gateway_units_and_rounded_sum(self):
        r=gateway_record(self.historical(),1,'2026-09-24',datetime.now())
        self.assertEqual(r['main_net_in'],30000)
        self.assertEqual(r['small_net_in'],-20000)
        self.assertEqual(r['source_key'],'tushare_gateway_eastmoney')

    def test_placeholders_are_excluded_but_corrupt_zero_quotes_fail(self):
        zero={**self.historical(),**{k:0 for k in ('close','pct_change','net_amount','buy_elg_amount','buy_lg_amount','buy_md_amount','buy_sm_amount')}}
        records,excluded=prepare_rows([zero],{},'2026-09-24')
        self.assertEqual(records,[])
        self.assertEqual(excluded,{'zero_quote_and_flow_placeholder':1})
        with self.assertRaises(ValueError):
            prepare_rows([{**zero,'net_amount':1}],{},'2026-09-24')
        with self.assertRaises(ValueError):
            prepare_rows([self.historical()],{},'2026-09-24')

    def test_duplicate_staged_securities_fail(self):
        with self.assertRaises(ValueError):
            prepare_rows([self.historical()]*2,{'600000.SH':Instrument(1,'600000','SH')},'2026-09-24')

    def test_pagination_requires_unique_complete_results(self):
        response=Mock(); response.json.return_value=dict(success=True,result=dict(count=2,pages=1,data=[self.web()]*2))
        session=Mock();session.get.return_value=response
        with self.assertRaises(ValueError): fetch_web_rows('2026-09-24',session,0)
        response.json.return_value=dict(success=True,result=dict(count=2,pages=1,data=[self.web()]))
        with self.assertRaises(ValueError): fetch_web_rows('2026-09-24',session,0)

    def test_writer_rejects_source_mixing_and_frozen_legacy(self):
        connection=Mock()
        with self.assertRaises(ValueError):
            upsert_records(connection,[{'source_key':'akshare_eastmoney'}],table=WEB_TABLE)
        with patch('update.LEGACY_FROZEN') as frozen:
            frozen.exists.return_value=True
            with self.assertRaises(RuntimeError): upsert_records(connection,[{}])
        connection.cursor.assert_not_called()
