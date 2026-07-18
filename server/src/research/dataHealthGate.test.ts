import { describe, expect, it } from 'vitest';
import {
  evaluateDataHealthGate,
  evaluateMarketCollectorHealth,
  type MarketCollectorState,
  type ReferenceDataState,
} from './dataHealthGate.js';

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

  it('checks dragon tiger only after 18:30 on an open trading day', () => {
    const state: MarketCollectorState = {
      expectedTradingDate: '2026-07-20',
      latestDragonTigerDate: '2026-07-17',
      runs: [{
        jobType: 'market_news', status: 'succeeded', startedAt: '2026-07-20T10:32:00.000Z',
        finishedAt: '2026-07-20T10:32:10.000Z', consecutiveFailures: 0, errorMessage: null,
      }],
      newsSources: [{
        sourceKey: 'eastmoney_global', latestPublishedAt: '2026-07-20T10:30:00.000Z',
        latestFetchedAt: '2026-07-20T10:32:10.000Z',
      }],
    };
    const before = evaluateMarketCollectorHealth(state, new Date('2026-07-20T10:20:00.000Z'));
    expect(before.find((check) => check.key === 'dragon_tiger_freshness')?.status).toBe('pass');
    const after = evaluateMarketCollectorHealth(state, new Date('2026-07-20T10:35:00.000Z'));
    expect(after.find((check) => check.key === 'dragon_tiger_freshness')?.status).toBe('fail');
  });

  it('uses fetched time for collector health while retaining published time as evidence metadata', () => {
    const checks = evaluateMarketCollectorHealth({
      expectedTradingDate: '2026-07-17',
      latestDragonTigerDate: '2026-07-17',
      runs: [{
        jobType: 'market_news', status: 'succeeded', startedAt: '2026-07-18T04:58:00.000Z',
        finishedAt: '2026-07-18T04:58:05.000Z', consecutiveFailures: 0, errorMessage: null,
      }],
      newsSources: [{
        sourceKey: 'eastmoney_global', latestPublishedAt: '2026-07-17T01:00:00.000Z',
        latestFetchedAt: '2026-07-18T04:58:05.000Z',
      }],
    }, new Date('2026-07-18T05:00:00.000Z'));
    expect(checks.find((check) => check.key === 'market_news_collector_heartbeat')?.status).toBe('pass');
    const source = checks.find((check) => check.key === 'market_news_source_success');
    expect(source?.status).toBe('pass');
    expect((source?.details.sources as Array<{ latestPublishedAt: string }>)[0]?.latestPublishedAt)
      .toBe('2026-07-17T01:00:00.000Z');
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
