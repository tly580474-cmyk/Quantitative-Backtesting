import { describe, expect, it } from 'vitest';
import {
  deriveCompressedFactors,
  validateHfqCrosscheck,
  validateReconstruction,
  type PriceRow,
} from './factor.js';

function row(
  tradeDate: string,
  close: number,
  multiplier = 1,
): PriceRow {
  return {
    tradeDate,
    open: close * multiplier,
    high: (close + 1) * multiplier,
    low: (close - 1) * multiplier,
    close: close * multiplier,
  };
}

describe('deriveCompressedFactors', () => {
  it('compresses unchanged consecutive factors and normalizes the latest factor', () => {
    const raw = [
      row('2024-01-01', 10),
      row('2024-01-02', 11),
      row('2024-01-03', 12),
      row('2024-01-04', 13),
    ];
    const qfq = [
      row('2024-01-01', 10, 0.5),
      row('2024-01-02', 11, 0.5),
      row('2024-01-03', 12),
      row('2024-01-04', 13),
    ];

    const result = deriveCompressedFactors(raw, qfq);

    expect(result.factors).toHaveLength(2);
    expect(result.factors[0]).toEqual({
      effectiveDate: '2024-01-01',
      factor: expect.closeTo(0.5, 10),
      offset: expect.closeTo(0, 10),
    });
    expect(result.factors[1]).toEqual({
      effectiveDate: '2024-01-03',
      factor: 1,
      offset: 0,
    });
    expect(result.qfqStats.withinTickRatio).toBe(1);
  });

  it('compresses an affine cash-dividend adjustment with negative historical prices', () => {
    const raw = [
      row('2024-01-01', 10),
      row('2024-01-02', 12),
      row('2024-01-03', 14),
    ];
    const qfq = raw.map((item, index) => index < 2
      ? {
          tradeDate: item.tradeDate,
          open: item.open * 0.5 - 6,
          high: item.high * 0.5 - 6,
          low: item.low * 0.5 - 6,
          close: item.close * 0.5 - 6,
        }
      : item);

    const result = deriveCompressedFactors(raw, qfq);

    expect(result.factors).toHaveLength(2);
    expect(result.factors[0].factor).toBeCloseTo(0.5, 8);
    expect(result.factors[0].offset).toBeCloseTo(-6, 8);
    expect(result.qfqStats.withinTickRatio).toBe(1);
  });

  it('tolerates one corrupt OHLC field without creating a false factor change', () => {
    const raw = [row('2024-01-01', 10), row('2024-01-02', 10)];
    const qfq = raw.map((item) => ({ ...item }));
    qfq[1].close += 0.02;

    const result = deriveCompressedFactors(raw, qfq);

    expect(result.factors).toHaveLength(1);
    expect(result.factors[0].factor).toBe(1);
    expect(result.qfqStats.withinTickPrices).toBe(7);
    expect(result.qfqStats.comparedPrices).toBe(8);
  });

  it('keeps qfq-only rows before the first authoritative raw date as overrides', () => {
    const raw = [row('2024-01-02', 10)];
    const early = row('2024-01-01', 9, 0.5);
    const result = deriveCompressedFactors(raw, [early, row('2024-01-02', 10)]);

    expect(result.qfqOnlyEarlyRows).toEqual([early]);
    expect(result.missingRawRows).toBe(0);
  });

  it('uses the same factor series to reconstruct hfq prices', () => {
    const raw = [
      row('2024-01-01', 10),
      row('2024-01-02', 12),
      row('2024-01-03', 14),
    ];
    const qfq = [
      row('2024-01-01', 10, 0.5),
      row('2024-01-02', 12, 0.5),
      row('2024-01-03', 14),
    ];
    const hfq = [
      row('2024-01-01', 10),
      row('2024-01-02', 12),
      row('2024-01-03', 14, 2),
    ];
    const derived = deriveCompressedFactors(raw, qfq);

    expect(validateHfqCrosscheck(raw, qfq, hfq, derived.factors).withinTickRatio).toBe(1);
  });
});
