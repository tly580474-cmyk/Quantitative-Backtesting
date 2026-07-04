import { describe, expect, it } from 'vitest';
import { amountYuanToYi, mapHistoryBarsToCandles } from '../historyBar';

describe('amountYuanToYi', () => {
  it('converts history-v2 amount from yuan to 亿元', () => {
    expect(amountYuanToYi(1_500_287_176.22)).toBeCloseTo(15.0028717622, 10);
  });

  it('preserves a missing amount', () => {
    expect(amountYuanToYi(undefined)).toBeUndefined();
  });

  it('maps adjusted history bars without changing volume or amount units', () => {
    expect(mapHistoryBarsToCandles([{
      tradeDate: '2026-07-03',
      open: 10,
      high: 11,
      low: 9,
      close: 10.5,
      volume: 123,
      amount: 250_000_000,
      turnoverRatePct: 0.5,
    }], '000001')).toEqual([{
      time: '2026-07-03',
      symbol: '000001',
      open: 10,
      high: 11,
      low: 9,
      close: 10.5,
      volume: 123,
      turnover: 2.5,
      turnoverRatePct: 0.5,
    }]);
  });
});
