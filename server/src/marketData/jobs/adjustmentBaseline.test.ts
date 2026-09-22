import { describe, expect, it } from 'vitest';
import { buildAdjustmentBaseline } from './adjustmentBaseline.js';

const raw = [
  { tradeDate: '2026-09-01', open: 10, high: 11, low: 9, close: 10 },
  { tradeDate: '2026-09-02', open: 10, high: 12, low: 9, close: 11 },
  { tradeDate: '2026-09-03', open: 10, high: 13, low: 9, close: 12 },
];
describe('adjustment baseline validation', () => {
  it('accepts an identity only when the entire reference agrees', () => {
    expect(buildAdjustmentBaseline(raw, raw).factors).toEqual([
      { effectiveDate: '2026-09-01', factor: 1, offset: 0 },
    ]);
  });
  it('reconstructs a cash dividend before the latest anchor', () => {
    const qfq = raw.map((row, i) => i === 2 ? row : {
      ...row, open: row.open - 1, high: row.high - 1, low: row.low - 1, close: row.close - 1,
    });
    const result = buildAdjustmentBaseline(raw, qfq);
    expect(result.factors).toHaveLength(2);
    expect(result.qfqStats.withinTickRatio).toBe(1);
    expect(result.factors[0].offset).toBeCloseTo(-1, 4);
  });
  it('rejects truncated, stale, empty, duplicate, and non-finite references', () => {
    for (const reference of [[], raw.slice(1), raw.slice(0, -1), [...raw, raw[0]],
      [{ ...raw[0], close: NaN }, ...raw.slice(1)]]) {
      expect(() => buildAdjustmentBaseline(raw, reference)).toThrow();
    }
    expect(() => buildAdjustmentBaseline(raw.slice(1), raw)).toThrow();
  });
  it('rejects a qfq series anchored after the stored latest day', () => {
    expect(() => buildAdjustmentBaseline(raw, raw.map(row => ({
      ...row, open: row.open - 1, high: row.high - 1, low: row.low - 1, close: row.close - 1,
    })))).toThrow(/anchor/);
  });
});
