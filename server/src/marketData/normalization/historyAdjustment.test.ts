import { describe, expect, it } from 'vitest';
import { applyHistoryAdjustment } from './historyAdjustment.js';

const bars = [
  { tradeDate: '2024-01-01', open: 10, high: 11, low: 9, close: 10, volume: 100 },
  { tradeDate: '2024-01-02', open: 12, high: 13, low: 11, close: 12, volume: 200 },
  { tradeDate: '2024-01-03', open: 14, high: 15, low: 13, close: 14, volume: 300 },
];
const factors = [
  { effectiveDate: '2024-01-01', factor: 0.5, priceOffset: -1 },
  { effectiveDate: '2024-01-03', factor: 1, priceOffset: 0 },
];

describe('applyHistoryAdjustment', () => {
  it('applies qfq factor and cash offset while preserving volume', () => {
    const result = applyHistoryAdjustment(bars, factors, [], 'qfq');

    expect(result.map((bar) => bar.close)).toEqual([4, 5, 14]);
    expect(result.map((bar) => bar.volume)).toEqual([100, 200, 300]);
  });

  it('changes qfq basis to the earliest price system for hfq', () => {
    const result = applyHistoryAdjustment(bars, factors, [], 'hfq');

    expect(result.map((bar) => bar.close)).toEqual([10, 12, 30]);
  });

  it('prepends qfq-only early overrides', () => {
    const result = applyHistoryAdjustment(
      bars,
      factors,
      [{ tradeDate: '2023-12-29', open: 3, high: 4, low: 2, close: 3 }],
      'qfq',
    );

    expect(result[0]).toMatchObject({ tradeDate: '2023-12-29', close: 3 });
    expect(result).toHaveLength(4);
  });
});
