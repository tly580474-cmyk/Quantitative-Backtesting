import { describe, expect, it } from 'vitest';
import { calculateChipDistribution } from '../chipDistribution';
import type { KlinePoint } from '../types';

function candle(
  date: string,
  close: number,
  turnoverRatePct: number | undefined = 10,
): KlinePoint {
  return {
    date,
    open: close - 0.5,
    high: close + 1,
    low: close - 1,
    close,
    volume: 1000,
    turnoverRatePct,
  };
}

describe('calculateChipDistribution', () => {
  it('requires real daily turnover-rate coverage', () => {
    const incomplete = candle('2026-01-02', 11);
    incomplete.turnoverRatePct = undefined;
    expect(calculateChipDistribution([
      candle('2026-01-01', 10),
      incomplete,
    ])).toBeNull();
  });

  it('normalizes chip weights and places the peak inside the traded range', () => {
    const result = calculateChipDistribution([
      candle('2026-01-01', 10, 20),
      candle('2026-01-02', 11, 30),
      candle('2026-01-03', 12, 40),
    ]);

    expect(result).not.toBeNull();
    expect(result!.bins.reduce((sum, bin) => sum + bin.weight, 0)).toBeCloseTo(1, 10);
    expect(result!.peakPrice).toBeGreaterThanOrEqual(9);
    expect(result!.peakPrice).toBeLessThanOrEqual(13);
    expect(result!.profitRatio).toBeGreaterThan(0);
    expect(result!.profitRatio).toBeLessThanOrEqual(1);
  });

  it('moves the dominant cost area toward recent high-turnover prices', () => {
    const lowTurnover = Array.from({ length: 8 }, (_, index) =>
      candle(`2026-01-${String(index + 1).padStart(2, '0')}`, 10, 2));
    const result = calculateChipDistribution([
      ...lowTurnover,
      candle('2026-01-09', 20, 80),
    ]);

    expect(result!.peakPrice).toBeGreaterThan(18);
    expect(result!.averageCost).toBeGreaterThan(16);
  });
});
