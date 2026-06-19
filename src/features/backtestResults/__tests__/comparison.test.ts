import { describe, expect, it } from 'vitest';
import { normalizeBenchmark, normalizeDcaEquity } from '../comparison';
import type { Candle, EquityPoint } from '@/models';

describe('DCA benchmark comparison', () => {
  it('shows DCA cumulative return against cumulative contributions', () => {
    const points: EquityPoint[] = [
      { time: '2021-01-01', cash: 0, marketValue: 100, equity: 100, drawdown: 0, positionQuantity: 10, contributedCapital: 100 },
      { time: '2021-01-02', cash: 0, marketValue: 220, equity: 220, drawdown: 0, positionQuantity: 20, contributedCapital: 200 },
      { time: '2021-01-03', cash: 0, marketValue: 200, equity: 200, drawdown: 0, positionQuantity: 20, contributedCapital: 200 },
    ];
    const normalized = normalizeDcaEquity(points);
    expect(normalized[0].value).toBe(100);
    expect(normalized[1].value).toBeCloseTo(110, 6);
    expect(normalized[2].value).toBeCloseTo(100, 6);
  });

  it('normalizes benchmark closes to 100 over the result period', () => {
    const candles: Candle[] = [
      { time: '2020-12-31', symbol: 'TEST', open: 9, high: 10, low: 8, close: 9 },
      { time: '2021-01-01', symbol: 'TEST', open: 10, high: 11, low: 9, close: 10 },
      { time: '2021-01-02', symbol: 'TEST', open: 12, high: 13, low: 11, close: 12 },
    ];
    expect(normalizeBenchmark(candles, '2021-01-01', '2021-01-02')).toEqual([
      { time: '2021-01-01', value: 100 },
      { time: '2021-01-02', value: 120 },
    ]);
  });
});
