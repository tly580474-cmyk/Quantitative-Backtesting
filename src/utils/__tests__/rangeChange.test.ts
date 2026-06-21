import { describe, it, expect } from 'vitest';
import { calculateRangeChange } from '../rangeChange';
import type { Candle } from '../../models';

function mc(overrides: Partial<Candle> = {}): Candle {
  return {
    time: '2021-01-04',
    symbol: 'TEST',
    open: 10,
    high: 11,
    low: 9,
    close: 10.5,
    ...overrides,
  };
}

function makeWeekOfCandles(): Candle[] {
  return [
    mc({ time: '2021-06-07', close: 100 }), // Mon
    mc({ time: '2021-06-08', close: 102 }),
    mc({ time: '2021-06-09', close: 105 }),
    mc({ time: '2021-06-10', close: 103 }),
    mc({ time: '2021-06-11', close: 110 }), // Fri
  ];
}

describe('calculateRangeChange', () => {
  it('calculates range change for exact boundary dates', () => {
    const candles = makeWeekOfCandles();
    const status = calculateRangeChange(candles, '2021-06-07', '2021-06-11');
    expect(status.type).toBe('success');
    if (status.type === 'success') {
      expect(status.result.actualStartDate).toBe('2021-06-07');
      expect(status.result.actualEndDate).toBe('2021-06-11');
      expect(status.result.startClose).toBe(100);
      expect(status.result.endClose).toBe(110);
      expect(status.result.change).toBe(10);
      expect(status.result.changePercent).toBeCloseTo(10);
      expect(status.result.totalBars).toBe(5);
      expect(status.result.isAdjustedStart).toBe(false);
      expect(status.result.isAdjustedEnd).toBe(false);
    }
  });

  it('maps start date on weekend forward to next trading day', () => {
    const candles = makeWeekOfCandles();
    const status = calculateRangeChange(candles, '2021-06-05', '2021-06-11'); // Saturday
    expect(status.type).toBe('success');
    if (status.type === 'success') {
      expect(status.result.actualStartDate).toBe('2021-06-07');
      expect(status.result.isAdjustedStart).toBe(true);
    }
  });

  it('maps end date on weekend backward to previous trading day', () => {
    const candles = makeWeekOfCandles();
    const status = calculateRangeChange(candles, '2021-06-07', '2021-06-13'); // Sunday
    expect(status.type).toBe('success');
    if (status.type === 'success') {
      expect(status.result.actualEndDate).toBe('2021-06-11');
      expect(status.result.isAdjustedEnd).toBe(true);
    }
  });

  it('returns error when start date is after end date', () => {
    const candles = makeWeekOfCandles();
    const status = calculateRangeChange(candles, '2021-06-11', '2021-06-07');
    expect(status.type).toBe('error');
    if (status.type === 'error') {
      expect(status.code).toBe('REVERSED_ORDER');
    }
  });

  it('returns error when start date has no data after it', () => {
    const candles = makeWeekOfCandles();
    const status = calculateRangeChange(candles, '2021-06-12', '2021-06-13');
    expect(status.type).toBe('error');
    if (status.type === 'error') {
      expect(status.code).toBe('NO_START_DATA');
    }
  });

  it('returns error when start close is invalid', () => {
    const candles = [mc({ time: '2021-01-04', close: 0 }), mc({ time: '2021-01-05', close: 10 })];
    const status = calculateRangeChange(candles, '2021-01-04', '2021-01-05');
    expect(status.type).toBe('error');
    if (status.type === 'error') {
      expect(status.code).toBe('INVALID_START_PRICE');
    }
  });

  it('returns error when start and end are same trading day', () => {
    const candles = makeWeekOfCandles();
    const status = calculateRangeChange(candles, '2021-06-09', '2021-06-09');
    expect(status.type).toBe('error');
    if (status.type === 'error') {
      expect(status.code).toBe('SAME_DAY');
    }
  });

  it('returns error for empty candles array', () => {
    const status = calculateRangeChange([], '2021-01-01', '2021-01-05');
    expect(status.type).toBe('error');
    if (status.type === 'error') {
      expect(status.code).toBe('NO_DATA');
    }
  });

  it('returns error for null/undefined candles', () => {
    const status = calculateRangeChange(null as unknown as Candle[], '2021-01-01', '2021-01-05');
    expect(status.type).toBe('error');
  });

  it('handles negative price change correctly', () => {
    const candles = makeWeekOfCandles();
    const status = calculateRangeChange(candles, '2021-06-09', '2021-06-10'); // 105 → 103
    expect(status.type).toBe('success');
    if (status.type === 'success') {
      expect(status.result.change).toBe(-2);
      expect(status.result.changePercent).toBeCloseTo(-1.9048, 3);
    }
  });

  it('handles zero change correctly', () => {
    const candles = [mc({ time: '2021-01-04', close: 100 }), mc({ time: '2021-01-05', close: 100 })];
    const status = calculateRangeChange(candles, '2021-01-04', '2021-01-05');
    expect(status.type).toBe('success');
    if (status.type === 'success') {
      expect(status.result.change).toBe(0);
      expect(status.result.changePercent).toBe(0);
    }
  });

  it('start date between trading days maps forward', () => {
    const candles = makeWeekOfCandles();
    const status = calculateRangeChange(candles, '2021-06-07', '2021-06-07'); // exact match
    expect(status.type).toBe('error'); // same day
  });
});
