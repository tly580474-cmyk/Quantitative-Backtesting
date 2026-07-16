import { describe, expect, it } from 'vitest';
import { evaluateDataHealthGate, type ReferenceDataState } from './dataHealthGate.js';

const references: ReferenceDataState = {
  dividends: {
    totalStocks: 5000,
    completed: 4500,
    noData: 500,
    failed: 0,
    attempted: 5000,
    events: 17000,
    symbolsWithEvents: 3900,
  },
  indexConstituents: {
    snapshots: 24,
    distinctDates: 24,
    weightedSnapshots: 24,
    minDate: '2024-01-01',
    maxDate: '2026-07-15',
  },
  swIndustry: {
    activeStocks: 5000,
    coveredStocks: 4999,
    barMaxDate: '2026-07-16',
    industries: 31,
    barRows: 140000,
  },
};

describe('data health gate', () => {
  it('passes only when all stores and reference datasets satisfy the gate', () => {
    const report = evaluateDataHealthGate(
      {
        status: 'current',
        snapshot: { snapshotId: 'snapshot-1', rowCount: 100, maxDate: '2026-07-16' },
        mysql: { rowCount: 100, maxDate: '2026-07-16' },
        message: 'current',
      },
      {
        status: 'ready',
        dataset: 'a-share-1m-price',
        preparedAt: '2026-07-16T16:00:00Z',
        startYear: 2010,
        endYear: 2026,
        firstDate: '2010-01-04',
        lastDate: '2026-07-16',
        tradingDays: 4000,
        parquetBytes: 1,
        years: [],
      },
      references,
      {
        datasets: {
          dividend_events: { rows: 17000, maxDate: null },
          index_constituent_snapshots: { rows: 24, maxDate: '2026-07-15' },
          sw_industry_bars: { rows: 140000, maxDate: '2026-07-16' },
        },
      },
    );
    expect(report.status).toBe('pass');
    expect(report.checks.every((check) => check.status === 'pass')).toBe(true);
  });

  it('fails on stale minute data, ambiguous dividend gaps, and insufficient index history', () => {
    const report = evaluateDataHealthGate(
      {
        status: 'current',
        snapshot: { snapshotId: 'snapshot-1', rowCount: 100, maxDate: '2026-07-16' },
        mysql: { rowCount: 100, maxDate: '2026-07-16' },
        message: 'current',
      },
      {
        status: 'ready',
        dataset: 'a-share-1m-price',
        preparedAt: '2026-07-15T16:00:00Z',
        startYear: 2010,
        endYear: 2026,
        firstDate: '2010-01-04',
        lastDate: '2026-07-15',
        tradingDays: 3999,
        parquetBytes: 1,
        years: [],
      },
      {
        ...references,
        dividends: { ...references.dividends, completed: 4400, failed: 10, attempted: 4910 },
        indexConstituents: {
          snapshots: 2,
          distinctDates: 2,
          weightedSnapshots: 1,
          minDate: '2026-06-30',
          maxDate: '2026-07-15',
        },
      },
      {
        datasets: {
          dividend_events: { rows: 16000, maxDate: null },
          index_constituent_snapshots: { rows: 2, maxDate: '2026-07-15' },
          sw_industry_bars: { rows: 140000, maxDate: '2026-07-16' },
        },
      },
    );
    expect(report.status).toBe('fail');
    expect(report.checks.filter((check) => check.status === 'fail').map((check) => check.key))
      .toEqual(expect.arrayContaining([
        'reference_snapshot',
        'minute_lake',
        'dividend_coverage',
        'index_constituents',
      ]));
  });
});
