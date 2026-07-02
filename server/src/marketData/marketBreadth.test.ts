import { describe, expect, it } from 'vitest';
import { buildMarketBreadthSnapshot, calculateMarketSentiment } from './aStockDataService.js';

function row(code: string, name: string, changePct: number, extra: Record<string, unknown> = {}) {
  return {
    f12: code,
    f14: name,
    f2: 10 * (1 + changePct / 100),
    f3: changePct,
    f6: 100_000_000,
    f7: 4,
    f8: 2,
    f10: 1.2,
    f62: 0,
    ...extra,
  };
}

describe('market breadth snapshot', () => {
  it('uses exact daily limit prices instead of a universal 9.8% threshold', () => {
    const snapshot = buildMarketBreadthSnapshot([
      row('600001', '主板涨停', 10, { f2: 11, f47: 11, f48: 9 }),
      row('300001', '创业板上涨', 10, { f2: 11, f47: 12, f48: 8 }),
      row('688001', '科创板涨停', 20, { f2: 12, f47: 12, f48: 8 }),
      row('920001', '北交所上涨', 10, { f2: 11, f47: 13, f48: 7 }),
    ]);

    expect(snapshot.distribution.find((bucket) => bucket.key === 'upLimit')?.items.map((item) => item.code))
      .toEqual(['688001', '600001']);
    expect(snapshot.distribution.find((bucket) => bucket.key === 'up5')?.items.map((item) => item.code))
      .toEqual(['300001', '920001']);
  });

  it('falls back to board-specific thresholds when exact limit fields are unavailable', () => {
    const snapshot = buildMarketBreadthSnapshot([
      row('600001', '主板', 9.8),
      row('300001', '创业板', 19.8),
      row('920001', '北交所', 29.8),
    ]);

    expect(snapshot.upLimit).toBe(3);
  });

  it('deduplicates stocks, excludes risk names, and keeps all buckets conservative', () => {
    const snapshot = buildMarketBreadthSnapshot([
      row('600001', '上涨股', 2),
      row('600001', '重复行情', 3),
      row('000001', '下跌股', -2),
      row('600002', '平盘股', 0),
      row('600003', 'ST风险股', 5),
      { f12: '600004', f14: '无报价', f3: null },
    ]);
    const bucketTotal = snapshot.distribution.reduce((sum, bucket) => sum + bucket.count, 0);

    expect(snapshot).toMatchObject({ total: 3, advancers: 1, decliners: 1, flat: 1 });
    expect(bucketTotal).toBe(snapshot.total);
  });
});

describe('market sentiment v2', () => {
  it('identifies small-cap-led divergence instead of reporting euphoria when the index falls', () => {
    const snapshot = buildMarketBreadthSnapshot([
      row('600001', '上涨一', 2),
      row('600002', '上涨二', 1.5),
      row('600003', '上涨三', 1),
      row('600004', '下跌一', -1),
    ]);
    const result = calculateMarketSentiment(snapshot, [
      { code: '000300', changePct: -2 },
      { code: '399001', changePct: -1.8 },
      { code: '000905', changePct: -1.2 },
      { code: '000852', changePct: -0.8 },
      { code: '000688', changePct: -2.5 },
    ]);

    expect(result.structure).toBe('small-cap-led');
    expect(result.structureLabel).toBe('结构性分化');
    expect(result.factors.find((factor) => factor.key === 'A')?.value).toBe(50);
    expect(result.factors.find((factor) => factor.key === 'C')?.value).toBeLessThan(-70);
    expect(result.msi).toBeLessThan(30);
  });

  it('uses liquidity-aware return strength rather than stock count alone', () => {
    const snapshot = buildMarketBreadthSnapshot([
      row('600001', '微量上涨一', 2, { f6: 100_000_000 }),
      row('600002', '微量上涨二', 2, { f6: 100_000_000 }),
      row('600003', '微量上涨三', 2, { f6: 100_000_000 }),
      row('600004', '微量上涨四', 2, { f6: 100_000_000 }),
      row('600005', '放量下跌', -3, { f6: 10_000_000_000 }),
    ]);
    const result = calculateMarketSentiment(snapshot, [{ code: '000300', changePct: 0 }]);

    expect(result.factors.find((factor) => factor.key === 'A')?.value).toBe(60);
    expect(result.factors.find((factor) => factor.key === 'B')?.value).toBeLessThan(0);
  });

  it('keeps factor weights normalized when index quotes are unavailable', () => {
    const snapshot = buildMarketBreadthSnapshot([
      row('600001', '上涨股', 2),
      row('600002', '下跌股', -1),
    ]);
    const result = calculateMarketSentiment(snapshot, []);

    expect(result.factors.reduce((sum, factor) => sum + factor.weight, 0)).toBeCloseTo(1);
    expect(result.factors.find((factor) => factor.key === 'C')?.weight).toBe(0);
  });
});
