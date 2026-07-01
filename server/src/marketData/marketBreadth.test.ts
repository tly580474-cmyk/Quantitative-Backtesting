import { describe, expect, it } from 'vitest';
import { buildMarketBreadthSnapshot } from './aStockDataService.js';

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
