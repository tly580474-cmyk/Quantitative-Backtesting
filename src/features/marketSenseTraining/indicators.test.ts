import { describe, expect, it } from 'vitest';
import type { KlinePoint } from '@/features/marketData/types';
import { calculateTrainingIndicators } from './indicators';
import { calculateSupertrend } from '@/features/indicators/supertrend';

function bars(values: number[]): KlinePoint[] {
  return values.map((close, index) => ({
    date: `2026-01-${String(index + 1).padStart(2, '0')}`,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1000,
  }));
}

describe('market-sense indicators', () => {
  it('uses the shared daily Supertrend without future data in training snapshots', () => {
    const data = bars([10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 20, 4, 11]);
    const expected = calculateSupertrend(data);
    const values = calculateTrainingIndicators(data);
    expect(values.map((value) => value.supertrend)).toEqual(expected.value);
    expect(values.map((value) => value.supertrendDirection)).toEqual(expected.direction);
    expect(calculateTrainingIndicators(data.slice(0, 11))).toEqual(values.slice(0, 11));
  });
  it('calculates moving averages and Bollinger bands after warmup', () => {
    const result = calculateTrainingIndicators(bars(new Array(20).fill(10)));
    const latest = result[19];

    expect(latest.ma5).toBe(10);
    expect(latest.ma10).toBe(10);
    expect(latest.ma20).toBe(10);
    expect(latest.bollUpper).toBe(10);
    expect(latest.bollLower).toBe(10);
  });

  it('calculates RSI and MACD series for trending data', () => {
    const result = calculateTrainingIndicators(bars(
      Array.from({ length: 40 }, (_value, index) => 10 + index),
    ));
    const latest = result[result.length - 1];

    expect(latest.rsi14).toBe(100);
    expect(latest.macdDif).toBeGreaterThan(0);
    expect(Number.isFinite(latest.macdHistogram)).toBe(true);
  });
});
