"""Audited one-time import of staged moneyflow_dc responses; never overwrites history.

The staging directory must contain gateway-YYYY-MM-DD.json for every whole missing
trading date and a reference date already present in the legacy store. Credentials
are deliberately not accepted by this offline importer.
"""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import UTC, datetime
import hashlib
import json
from pathlib import Path

from sources import HISTORY_SOURCE, HISTORY_VERSION, business_date, gateway_record, number
from update import UPSERT_FIELDS, LEGACY_FROZEN, load_env, connect_db, load_instruments, write_progress

AMOUNTS = ('net_amount', 'buy_elg_amount', 'buy_lg_amount', 'buy_md_amount', 'buy_sm_amount')


def prepare_rows(raw, instruments, trade_date):
    records, excluded, seen = [], Counter(), set()
    now = datetime.now(UTC).replace(tzinfo=None)
    for row in raw:
        code = str(row.get('ts_code', ''))
        if code in seen or business_date(row.get('trade_date')) != trade_date:
            raise ValueError('duplicate security or incorrect staging date')
        seen.add(code)
        if (code.startswith('2') and code.endswith('.SZ')) or (code.startswith('900') and code.endswith('.SH')):
            excluded['B_share'] += 1
            continue
        if number(row.get('close')) == 0:
            if any(number(row.get(key)) != 0 for key in (*AMOUNTS, 'pct_change')):
                raise ValueError(f'nonzero flow with zero quote: {code}')
            excluded['zero_quote_and_flow_placeholder'] += 1
            continue
        instrument = instruments.get(code)
        if instrument is None:
            raise ValueError(f'unmapped active A-share: {code}')
        records.append(gateway_record(row, instrument.instrument_key, trade_date, now))
    return records, dict(excluded)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--staging', type=Path, required=True)
    parser.add_argument('--end', required=True)
    parser.add_argument('--reference', required=True)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    end, reference = business_date(args.end), business_date(args.reference)
    if LEGACY_FROZEN.exists():
        raise RuntimeError('legacy store already frozen; one-time import disabled')
    load_env()
    connection = connect_db()
    try:
        with connection.cursor() as cursor:
            cursor.execute("SELECT GET_LOCK('fund-flow-gap-cutover',0) acquired")
            if cursor.fetchone()['acquired'] != 1:
                raise RuntimeError('another backfill is running')
            cursor.execute('SELECT MIN(trade_date) start_date FROM stock_fund_flows')
            start = cursor.fetchone()['start_date']
            if not start:
                raise RuntimeError('existing history required')
            cursor.execute("SELECT DISTINCT trade_date FROM trading_calendar WHERE market='SH' "
                           "AND is_open=1 AND trade_date BETWEEN %s AND %s ORDER BY trade_date", (start, end))
            calendar = [str(r['trade_date'])[:10] for r in cursor.fetchall()]
            cursor.execute('SELECT DISTINCT trade_date FROM stock_fund_flows WHERE trade_date BETWEEN %s AND %s', (start, end))
            present = {str(r['trade_date'])[:10] for r in cursor.fetchall()}
        gaps = [d for d in calendar if d not in present]
        if not gaps:
            raise RuntimeError('no missing whole trading dates')
        instruments, _ = load_instruments(connection)
        manifest = dict(end=end, missingDates=gaps, sourceKey=HISTORY_SOURCE, sourceVersion=HISTORY_VERSION, dates={})
        staged = {}
        for d in [reference, *gaps]:
            payload = (args.staging / f'gateway-{d}.json').read_bytes()
            raw = json.loads(payload)
            records, excluded = prepare_rows(raw, instruments, d)
            with connection.cursor() as cursor:
                cursor.execute('SELECT instrument_key FROM daily_bars_v2 WHERE trade_date=%s', (d,))
                expected = {r['instrument_key'] for r in cursor.fetchall()}
            keys = {r['instrument_key'] for r in records}
            if not expected or expected - keys:
                raise ValueError(f'{d}: staging does not cover every local daily-bar security')
            extras = [r for r in records if r['instrument_key'] not in expected]
            if any(any(r[k] != 0 for k in ('main_net_in','super_large_net_in','large_net_in','medium_net_in','small_net_in')) for r in extras):
                raise ValueError(f'{d}: nonzero flows without local daily-bar reference')
            manifest['dates'][d] = dict(providerRows=len(raw), storedRows=len(records), excluded=excluded,
                                        dailyBarReference=len(expected), zeroFlowExtraRows=len(extras), sha256=hashlib.sha256(payload).hexdigest())
            staged[d] = records
        with connection.cursor() as cursor:
            cursor.execute('SELECT * FROM stock_fund_flows WHERE trade_date=%s', (reference,))
            old = {r['instrument_key']:r for r in cursor.fetchall()}
        comparison = Counter()
        maximum = Counter()
        for r in staged[reference]:
            if r['instrument_key'] not in old:
                continue
            previous = old[r['instrument_key']]
            if previous['source_key'] != 'akshare_eastmoney':
                raise ValueError('reference must use verified Eastmoney methodology')
            for field in ('main_net_in','super_large_net_in','large_net_in','medium_net_in','small_net_in','close_price','change_pct'):
                tolerance = 50.01 if field.endswith('_net_in') else 0.000001
                delta = abs(r[field] - previous[field])
                if delta > tolerance:
                    raise ValueError(f'reference mismatch {r["instrument_key"]} {field}')
                comparison[field] += 1
                maximum[field] = max(maximum[field], delta)
        if len(old) < 1000 or any(comparison[f] != len(old) for f in comparison) or not comparison:
            raise ValueError('insufficient reference overlap')
        manifest['referenceComparison'] = dict(compared=dict(comparison), maxAbs=dict(maximum))
        with connection.cursor() as cursor:
            cursor.execute('SHOW CREATE TABLE stock_fund_flows')
            manifest['legacySchema'] = cursor.fetchone()['Create Table']
            cursor.execute('SELECT source_key,source_version,COUNT(*) n FROM stock_fund_flows GROUP BY source_key,source_version')
            manifest['beforeSources'] = cursor.fetchall()
        output = args.staging / ('import-applied.json' if args.apply else 'import-plan.json')
        manifest['applied'] = False
        output.write_text(json.dumps(manifest, ensure_ascii=False, indent=2, default=str), encoding='utf-8')
        if args.apply:
            connection.rollback()
            connection.begin()
            with connection.cursor() as cursor:
                for d in gaps:
                    cursor.execute('SELECT instrument_key FROM stock_fund_flows WHERE trade_date=%s FOR UPDATE', (d,))
                    if cursor.fetchone():
                        raise RuntimeError(f'{d} is no longer empty; abort without overwriting')
                    sql = f"INSERT INTO stock_fund_flows ({','.join(UPSERT_FIELDS)}) VALUES ({','.join(['%s']*len(UPSERT_FIELDS))})"
                    for offset in range(0,len(staged[d]),1000):
                        cursor.executemany(sql, [[r[f] for f in UPSERT_FIELDS] for r in staged[d][offset:offset+1000]])
                    counts = manifest['dates'][d]
                    cursor.execute('INSERT INTO fund_flow_sync_dates (source_key,trade_date,status,provider_rows,stored_rows,expected_market_rows,coverage_pct,updated_at) '
                                   'VALUES (%s,%s,%s,%s,%s,%s,%s,%s)',
                                   (HISTORY_SOURCE,d,'completed',counts['providerRows'],counts['storedRows'],counts['dailyBarReference'],
                                    counts['storedRows']/counts['dailyBarReference']*100,datetime.now(UTC).replace(tzinfo=None)))
            connection.commit()
            manifest['applied'] = True
            output.write_text(json.dumps(manifest,ensure_ascii=False,indent=2,default=str),encoding='utf-8')
            write_progress(LEGACY_FROZEN, status='frozen', through=end, sourceKey=HISTORY_SOURCE, manifest=str(output))
        print(json.dumps(dict(applied=manifest['applied'], missingDates=gaps,
                              rows={d:len(staged[d]) for d in gaps}, manifest=str(output)),ensure_ascii=False))
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


if __name__ == '__main__':
    main()
