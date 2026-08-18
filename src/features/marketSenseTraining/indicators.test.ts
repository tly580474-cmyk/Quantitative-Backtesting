import { describe, expect, it } from 'vitest';
import type { KlinePoint } from '@/features/marketData/types';
import { calculateTrainingIndicators } from './indicators';

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
