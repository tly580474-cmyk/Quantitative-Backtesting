import { describe, expect, it } from 'vitest';
import type { KlinePoint, StockQuote, StockSearchItem } from '../types';
import {
  calculateWatchlistMetrics,
  resolveWatchlistBaselinePrice,
} from '../watchlistMetrics';

const item: StockSearchItem = {
  code: '000001',
  name: '测试股票',
  market: 'SZ',
  type: 'stock',
  addedAt: '2026-07-01T09:30:00.000Z',
  addedPrice: 10,
};

function candles(count = 21): KlinePoint[] {
  return Array.from({ length: count }, (_, index) => ({
    date: `2026-07-${String(index + 1).padStart(2, '0')}`,
    open: 10 + index * 0.1,
    high: 11 + index * 0.1,
    low: 9 + index * 0.1,
    close: 10 + index * 0.1,
    volume: 1000,
  }));
}

describe('watchlist metrics', () => {
  it('calculates return from the captured add price', () => {
    const quote = { price: 12 } as StockQuote;
    const result = calculateWatchlistMetrics(item, quote, candles());

    expect(result.returnSinceAddedPct).toBeCloseTo(20);
  });

  it('uses the tighter of the 20-day structure low and 2 ATR protection price', () => {
    const quote = { price: 12 } as StockQuote;
    const result = calculateWatchlistMetrics(item, quote, candles());

    expect(result.riskPrice).toBeCloseTo(9.1);
    expect(result.riskDistancePct).toBeCloseTo(-24.1667);
  });

  it('does not invent risk price without enough daily bars', () => {
    const result = calculateWatchlistMetrics(item, null, candles(20));

    expect(result.riskPrice).toBeNull();
  });

  it('falls back to the latest available price when initializing a legacy item', () => {
    const legacy = { ...item, addedPrice: undefined };
    const quote = { price: 12.34 } as StockQuote;

    expect(resolveWatchlistBaselinePrice(legacy, quote, candles())).toBe(12.34);
  });
});
