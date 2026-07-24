import { describe, expect, it } from 'vitest';
import {
  aggregateMarketCapitalFlow,
  useStoredReferenceSnapshot,
} from './marketCapitalFlowService.js';

describe('market capital flow aggregation', () => {
  it('deduplicates stocks and excludes missing values from coverage', () => {
    const result = aggregateMarketCapitalFlow([
      { f12: '600001', f62: 300_000_000 },
      { f12: '600001', f62: 999_000_000 },
      { f12: '000001', f62: -100_000_000 },
      { f12: '000002', f62: null },
    ], 3);

    expect(result.mainNetInYi).toBe(2);
    expect(result.sampleCount).toBe(2);
    expect(result.coveragePct).toBe(66.67);
  });
});

describe('stored market capital flow reference', () => {
  const snapshot = {
    mainNetInYi: 12.5,
    sampleCount: 5200,
    total: 5500,
    coveragePct: 94.55,
    updatedAt: '2026-07-23T07:00:00.000Z',
    tradeDate: '2026-07-23',
    source: 'test',
  };

  it('uses the latest completed trading-day snapshot before open', () => {
    expect(useStoredReferenceSnapshot(snapshot, '2026-07-23')).toMatchObject({
      tradeDate: '2026-07-23',
      stale: true,
      fallbackReason: '盘前沿用上一完整交易日收盘资金流快照',
    });
  });

  it('does not use a snapshot from an older trading day', () => {
    expect(useStoredReferenceSnapshot(snapshot, '2026-07-24')).toBeNull();
  });
});
