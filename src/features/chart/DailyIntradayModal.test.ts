import { describe, expect, it } from 'vitest';
import { buildDailyIntradayPath, resolveIntradayChange, supportsHistoricalIntraday } from './DailyIntradayModal';

describe('buildDailyIntradayPath', () => {
  it('requests one exact trading day at one-minute resolution', () => {
    const path = buildDailyIntradayPath('600000', '2026-09-08');
    expect(path).toContain('/stocks/600000/minute?');
    const query = new URLSearchParams(path.split('?')[1]);
    expect(Object.fromEntries(query)).toMatchObject({
      startDate: '2026-09-08',
      endDate: '2026-09-08',
      interval: '1',
      includeZeroVolume: 'true',
      limit: '1000',
    });
  });

  it('encodes the symbol as a path segment', () => {
    expect(buildDailyIntradayPath('SH/000001', '2026-09-08')).toContain('/stocks/SH%2F000001/minute?');
  });
});

describe('resolveIntradayChange', () => {
  it('uses previous close rather than the opening price', () => {
    const result = resolveIntradayChange({
      close: 11,
      previousClose: 9,
      change: null,
      changePct: null,
    });
    expect(result.change).toBe(2);
    expect(result.changePct).toBeCloseTo(22.2222, 4);
  });

  it('keeps every minute anchored to the selected daily candle previous close', () => {
    const result = resolveIntradayChange({
      close: 7.77,
      previousClose: 7.78,
      change: -0.01,
      changePct: -0.13,
    }, 7.4);
    expect(result.change).toBeCloseTo(0.37, 8);
    expect(result.changePct).toBeCloseTo(5, 8);
  });

  it('uses minute-service values only when no previous-close anchor exists', () => {
    const result = resolveIntradayChange({
      close: 11,
      previousClose: null,
      change: 1.5,
      changePct: 15.79,
    });
    expect(result).toEqual({ change: 1.5, changePct: 15.79 });
  });
});

describe('supportsHistoricalIntraday', () => {
  it('prevents indexes and ETFs from falling through to the stock minute endpoint', () => {
    expect(supportsHistoricalIntraday('stock')).toBe(true);
    expect(supportsHistoricalIntraday('index')).toBe(false);
    expect(supportsHistoricalIntraday('etf')).toBe(false);
  });
});
