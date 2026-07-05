import { describe, expect, it } from 'vitest';
import type { Candle } from '@/models';
import { aggregateCandles } from '../timeframe';

const candles: Candle[] = [
  { time: '2026-06-29', symbol: '000001', open: 10, high: 11, low: 9, close: 10.5, volume: 100, turnover: 1, turnoverRatePct: 0.5 },
  { time: '2026-06-30', symbol: '000001', open: 10.5, high: 12, low: 10, close: 11, volume: 200, turnover: 2, turnoverRatePct: 0.7 },
  { time: '2026-07-01', symbol: '000001', open: 11, high: 13, low: 10.8, close: 12, volume: 300, turnover: 3, turnoverRatePct: 0.8 },
  { time: '2026-07-06', symbol: '000001', open: 12, high: 12.5, low: 11, close: 11.5, volume: 400, turnover: 4, turnoverRatePct: 0.9 },
];

describe('chart timeframe aggregation', () => {
  it('aggregates OHLCV by trading week using the final trading date', () => {
    expect(aggregateCandles(candles, 'week')).toEqual([
      expect.objectContaining({
        time: '2026-07-01',
        open: 10,
        high: 13,
        low: 9,
        close: 12,
        volume: 600,
        turnover: 6,
        turnoverRatePct: 2,
      }),
      expect.objectContaining({
        time: '2026-07-06',
        open: 12,
        high: 12.5,
        low: 11,
        close: 11.5,
        change: -0.5,
      }),
    ]);
  });

  it('aggregates by calendar month', () => {
    expect(aggregateCandles(candles, 'month')).toEqual([
      expect.objectContaining({
        time: '2026-06-30',
        open: 10,
        high: 12,
        low: 9,
        close: 11,
        volume: 300,
      }),
      expect.objectContaining({
        time: '2026-07-06',
        open: 11,
        high: 13,
        low: 10.8,
        close: 11.5,
        volume: 700,
        change: 0.5,
      }),
    ]);
  });

  it('returns an independent daily array without aggregation', () => {
    const result = aggregateCandles(candles, 'day');
    expect(result).toEqual(candles);
    expect(result).not.toBe(candles);
  });
});
