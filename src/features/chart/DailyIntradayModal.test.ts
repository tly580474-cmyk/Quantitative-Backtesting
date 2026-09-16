import { describe, expect, it } from 'vitest';
import { assessIntraday, hitsCandle, buildDailyIntradayPath, resolveIntradayChange, supportsHistoricalIntraday, type IntradayBar } from './DailyIntradayModal';

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
    }, 9);
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

  it('does not publish a daily return without a daily anchor', () => {
    const result = resolveIntradayChange({
      close: 11,
      previousClose: null,
      change: 1.5,
      changePct: 15.79,
    });
    expect(result).toEqual({ change: null, changePct: null });
  });
});

describe('supportsHistoricalIntraday', () => {
  it('prevents indexes and ETFs from falling through to the stock minute endpoint', () => {
    expect(supportsHistoricalIntraday('stock')).toBe(true);
    expect(supportsHistoricalIntraday('index')).toBe(false);
    expect(supportsHistoricalIntraday('etf')).toBe(false);
    expect(supportsHistoricalIntraday(undefined)).toBe(false);
  });
});

describe('raw daily assessment and candle interaction', () => {
  const bar: IntradayBar = { date: '2023-04-12 15:00:00', open: 10.07, high: 10.21, low: 10.02, close: 10.12, volume: 100, amount: 1012, previousClose: 10.10, change: 0.02, changePct: 0.2, isTradable: true };
  it('uses unadjusted daily close and detects missing session data', () => {
    const result = assessIntraday([bar], [
      { date: '2023-04-11', open: 9.96, high: 10.07, low: 9.78, close: 10.07 },
      { date: '2023-04-12', open: 10.07, high: 10.21, low: 10.02, close: 10.12 },
    ], '2023-04-12', false);
    expect(resolveIntradayChange(bar, result.previousClose).changePct).toBeCloseTo(0.496524);
    expect(result.warnings).toContain('分钟数据未覆盖完整交易时段，末价不代表收盘价');
  });
  it('rejects wrong-day data', () => {
    expect(() => assessIntraday([bar], [], '2023-04-13', false)).toThrow();
  });
  it('does not treat blank chart space as a candle hit', () => {
    expect(hitsCandle(100, 90, 110)).toBe(true);
    expect(hitsCandle(200, 90, 110)).toBe(false);
    expect(hitsCandle(100, null, 110)).toBe(false);
  });
});
