"""Reconcile saved disclosure, MySQL-universe and snapshot inventories offline.

Exclusions require independently verified listing-status evidence. This script
does not fetch data, modify securities, or write financial reports to MySQL.
"""
import argparse
import json
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--as-of', default=datetime.now(timezone(timedelta(hours=8))).date().isoformat())
    parser.add_argument('--exclude-symbols', default='', help='Comma-separated codes with verified exclusions')
    args = parser.parse_args()
    day = datetime.strptime(args.as_of, '%Y-%m-%d').date()
    folder = ROOT / 'output' / f'financial-coverage-{day}'

    def read(name):
        return json.loads((folder / name).read_text(encoding='utf-8'))

    excluded = set(filter(None, args.exclude_symbols.split(',')))
    instruments = read('mysql-recovered-evidence.json')['instruments']
    active = {x['symbol']: x for x in instruments if x['type']=='stock' and x['status']=='active'}
    if excluded - active.keys():
        raise ValueError('Exclusion contains a code outside the captured active universe')
    eligible = {k: v for k, v in active.items() if k not in excluded}
    source = read('eastmoney-a-share-midyear.json')
    disclosures = {x['SECURITY_CODE']: x for x in source['rows']
                   if x.get('NOTICE_DATE') and x['NOTICE_DATE'][:10] <= str(day)}
    if len({x['SECURITY_CODE'] for x in source['rows']}) != len(source['rows']):
        raise ValueError('Source contains duplicate security codes; review versions before reconciling')
    inventory = {x['symbol']: x for x in read('stock_inventory.json')}
    period = source['report_period']
    gaps = []
    for symbol in sorted(eligible.keys() & disclosures.keys()):
        report = disclosures[symbol]
        local = inventory.get(symbol, {})
        if local.get(f'has_{period}'):
            continue
        fetched = local.get('last_fetch_utc')
        fetched_date = (datetime.fromisoformat(fetched) + timedelta(hours=8)).date().isoformat() if fetched else None
        notice = report['NOTICE_DATE'][:10]
        reason = ('no_history' if not fetched_date else 'fetched_before_announcement' if fetched_date < notice
                  else 'fetched_same_day' if fetched_date == notice else 'fetched_after_announcement')
        gaps.append({'symbol': symbol, 'market': eligible[symbol]['market'],
                     'name': report['SECURITY_NAME_ABBR'], 'announcement_date': notice,
                     'local_last_period': local.get('last_period'), 'last_fetch_beijing_date': fetched_date,
                     'reason': reason})
    matched = eligible.keys() & disclosures.keys()
    summary = {'as_of': str(day), 'report_period': period,
               'captured_active_count': len(active), 'verified_excluded_symbols': sorted(excluded),
               'eligible_count': len(eligible), 'source_rows': len(source['rows']),
               'disclosed_matched': len(matched), 'local_period_covered': len(matched) - len(gaps),
               'missing_local_reports': len(gaps), 'gap_reasons': dict(Counter(x['reason'] for x in gaps)),
               'eligible_without_source_report': [eligible[s] for s in sorted(eligible.keys()-disclosures.keys())],
               'source_outside_eligible': sorted(disclosures.keys()-eligible.keys()),
               'limitations': 'Announcement dates are source metadata, not a verified per-field first-publication timestamp. This compares captured datasets, not live changing state.'}
    (folder/'reconciled-coverage.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding='utf-8')
    (folder/'missing-disclosed-midyear.json').write_text(json.dumps(gaps, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({k: v for k, v in summary.items() if k not in ('eligible_without_source_report','source_outside_eligible')}, ensure_ascii=True))


if __name__ == '__main__':
    main()
