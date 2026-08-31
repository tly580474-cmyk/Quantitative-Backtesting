"""Audit the published financial Parquet snapshot without connecting to MySQL.

Requires duckdb. Example: python scripts/audit-financial-coverage.py
The snapshot cannot identify stocks without reports or establish the full market
denominator; verify those separately. Output is written under output/.
"""
import argparse
import hashlib
import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

import duckdb

ROOT = Path(__file__).resolve().parents[1]
INCOME = "COALESCE(revenue,total_revenue) IS NOT NULL AND COALESCE(net_profit_parent,net_profit) IS NOT NULL"
BALANCE = "total_assets IS NOT NULL AND total_liabilities IS NOT NULL AND total_equity IS NOT NULL"
CASH = "net_operating_cash_flow IS NOT NULL AND net_investing_cash_flow IS NOT NULL AND net_financing_cash_flow IS NOT NULL"
CORE = f"({INCOME}) AND ({BALANCE}) AND ({CASH})"


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--as-of', default=datetime.now(timezone(timedelta(hours=8))).date().isoformat())
    p.add_argument('--snapshot-root', type=Path, default=ROOT / 'server/data/research-snapshots')
    args = p.parse_args()
    day = datetime.strptime(args.as_of, '%Y-%m-%d').date()
    out = ROOT / 'output' / f'financial-coverage-{day}'
    out.mkdir(parents=True, exist_ok=True)
    pointer = json.loads((args.snapshot_root / 'current.json').read_text(encoding='utf-8'))
    folder = args.snapshot_root / pointer['snapshotId']
    manifest = json.loads((folder / 'manifest.json').read_text(encoding='utf-8'))
    ds = next(x for x in manifest['datasets'] if x['name'] == 'financial_reports')
    path = folder / ds['relativePath']
    with path.open('rb') as f:
        digest = hashlib.file_digest(f, 'sha256').hexdigest()
    if digest != ds['sha256']:
        raise ValueError('Snapshot checksum mismatch')
    c = duckdb.connect()
    c.execute("SET threads=4")
    c.execute("SET memory_limit='1GB'")
    c.read_parquet(str(path)).create_view('raw')
    columns = c.execute('DESCRIBE raw').fetchall()
    names = {x[0]: re.sub(r'(?<!^)(?=[A-Z])', '_', x[0]).lower() for x in columns}
    expressions = []
    for old, new in names.items():
        expr = f'"{old}"'
        if new in ('report_period', 'announcement_date'):
            expr = f'CAST({expr} AS DATE)'
        elif new == 'fetched_at':
            expr = f'CAST({expr} AS TIMESTAMP)'
        expressions.append(f'{expr} AS "{new}"')
    setup = 'CREATE VIEW financial_reports AS SELECT ' + ','.join(expressions) + ' FROM raw'
    c.execute(setup)
    latest = f"""CREATE VIEW latest AS SELECT * FROM financial_reports
      WHERE announcement_date<=DATE '{day}' AND report_period<=DATE '{day}'
      QUALIFY ROW_NUMBER() OVER (PARTITION BY instrument_key,report_period
      ORDER BY announcement_date DESC,update_flag DESC,fetched_at DESC)=1"""
    c.execute(latest)
    result = {'as_of': str(day), 'created_at': datetime.now(timezone.utc).isoformat(),
      'source': 'Published Parquet snapshot; no database connection', 'pointer': pointer,
      'financial_manifest': ds, 'verified_sha256': digest,
      'limitations': 'Snapshot universe excludes stocks with no records. Latest versions do not establish point-in-time accuracy. Statement checks measure core field presence, not complete original documents.'}
    sql_log = ['-- Create raw with read_parquet for the financial_manifest.relativePath in summary.json.', setup+';', latest+';']

    def query(name, sql, detail=False):
        cursor = c.execute(sql)
        rows = [dict(zip([x[0] for x in cursor.description], row)) for row in cursor.fetchall()]
        sql_log.append(f'-- {name}\n{sql};')
        if detail:
            (out / f'{name}.json').write_text(json.dumps(rows, default=str, ensure_ascii=False, indent=2), encoding='utf-8')
            result[name] = {'file': f'{name}.json', 'rows': len(rows)}
        else:
            result[name] = rows
        print(f'{name}: {len(rows)} rows', flush=True)

    try:
        query('overview', f"""SELECT COUNT(*) raw_rows,COUNT(DISTINCT instrument_key) stocks,
          COUNT(DISTINCT (instrument_key,report_period)) stock_periods,MIN(report_period) first_period,
          MAX(report_period) last_period,MAX(announcement_date) last_announcement,MAX(fetched_at) last_fetch_utc,
          SUM(announcement_date<report_period) announcement_before_period,
          SUM(announcement_date>DATE '{day}') future_announcement,SUM(report_period>DATE '{day}') future_period,
          SUM(strftime(report_period,'%m-%d') NOT IN ('03-31','06-30','09-30','12-31')) nonstandard_periods
          FROM financial_reports""")
        query('periods', f"""SELECT report_period,COUNT(*) stocks,SUM({INCOME}) income_core,
          SUM({BALANCE}) balance_core,SUM({CASH}) cashflow_core,SUM({CORE}) three_statement_core,
          SUM(COALESCE(roe_weighted_pct,roe_pct) IS NOT NULL) reported_roe,
          SUM(COALESCE(roe_weighted_pct,roe_pct,roe_calculated_pct) IS NOT NULL) any_roe,
          COUNT(revenue_yoy_pct) revenue_yoy,COUNT(net_profit_yoy_pct) profit_yoy
          FROM latest GROUP BY report_period ORDER BY report_period""")
        query('recent_by_market', f"""SELECT report_period,market,COUNT(*) stocks,SUM({CORE}) three_statement_core,
          SUM(COALESCE(roe_weighted_pct,roe_pct) IS NOT NULL) reported_roe,
          COUNT(revenue_yoy_pct) revenue_yoy,COUNT(net_profit_yoy_pct) profit_yoy
          FROM latest WHERE report_period>=DATE '{day}'-INTERVAL 2 YEAR GROUP BY report_period,market ORDER BY report_period,market""")
        fields = ','.join(f'COUNT({names[x[0]]}) "{names[x[0]]}"' for x in columns if x[1] in ('DOUBLE','FLOAT'))
        query('field_coverage', f"""SELECT CASE WHEN report_period>=DATE '{day}'-INTERVAL 2 YEAR THEN CAST(report_period AS VARCHAR)
          ELSE 'older' END period_group,COUNT(*) stock_periods,{fields},SUM({CORE}) three_statement_core
          FROM latest GROUP BY period_group ORDER BY period_group""")
        flags = ','.join(f"MAX(IF(report_period=DATE '{year}-{md}',1,0)) AS \"has_{year}-{md}\""
          for year in (day.year-1,day.year) for md in ('03-31','06-30','09-30','12-31') if f'{year}-{md}'<=str(day))
        query('stock_inventory', f"""SELECT instrument_key,market,symbol,name,COUNT(*) periods,
          MIN(report_period) first_period,MAX(report_period) last_period,MAX(announcement_date) last_announcement,
          MAX(fetched_at) last_fetch_utc,{flags} FROM latest GROUP BY instrument_key,market,symbol,name ORDER BY market,symbol""", True)
        query('latest_period_distribution', 'SELECT last_period,COUNT(*) stocks FROM (SELECT instrument_key,MAX(report_period) last_period FROM latest GROUP BY instrument_key) GROUP BY last_period ORDER BY last_period')
        query('fetch_distribution', "SELECT CAST(last_fetch_utc+INTERVAL 8 HOUR AS DATE) last_fetch_beijing,COUNT(*) stocks FROM (SELECT instrument_key,MAX(fetched_at) last_fetch_utc FROM financial_reports GROUP BY instrument_key) GROUP BY last_fetch_beijing ORDER BY last_fetch_beijing")
        query('version_distribution', 'SELECT versions,COUNT(*) stock_periods FROM (SELECT instrument_key,report_period,COUNT(*) versions FROM financial_reports GROUP BY instrument_key,report_period) GROUP BY versions ORDER BY versions')
        query('announcement_first_lag', "SELECT COUNT(*) stock_periods,SUM(date_diff('day',report_period,first_ann)>365) first_announcement_over_1y,SUM(date_diff('day',report_period,last_ann)>365) latest_announcement_over_1y FROM (SELECT instrument_key,report_period,MIN(announcement_date) first_ann,MAX(announcement_date) last_ann FROM financial_reports GROUP BY instrument_key,report_period)")
        query('recent_incomplete', f"""SELECT symbol,name,market,report_period,announcement_date,({INCOME}) income_core,
          ({BALANCE}) balance_core,({CASH}) cashflow_core,revenue,total_revenue,net_profit,net_profit_parent,
          total_assets,total_liabilities,total_equity,equity_parent,net_operating_cash_flow,net_investing_cash_flow,net_financing_cash_flow
          FROM latest WHERE report_period>=DATE '{day}'-INTERVAL 2 YEAR AND NOT ({CORE}) ORDER BY report_period DESC,symbol""", True)
        query('sources', 'SELECT source_key,COUNT(*) raw_rows FROM financial_reports GROUP BY source_key')
        (out / 'summary.json').write_text(json.dumps(result, default=str, ensure_ascii=False, indent=2), encoding='utf-8')
        (out / 'queries.sql').write_text('\n'.join(sql_log), encoding='utf-8')
    finally:
        c.close()


if __name__ == '__main__':
    main()
