import { describe, it, expect } from 'vitest';
import { validateCandles } from '../validator';
import type { Candle } from '@/models';

function candle(overrides: Partial<Candle> = {}): Candle {
  return {
    time: '2021-06-21',
    symbol: '000852',
    open: 100,
    high: 110,
    low: 95,
    close: 105,
    volume: 1000000,
    turnover: 100,
    ...overrides,
  };
}

describe('validateCandles', () => {
  it('passes valid data', () => {
    const candles = [
      candle(),
      candle({ time: '2021-06-22', open: 105, high: 115, low: 100, close: 110 }),
    ];
    const result = validateCandles(candles);
    expect(result.errors).toHaveLength(0);
    expect(result.validCandles).toHaveLength(2);
  });

  it('rejects high < open', () => {
    const candles = [candle({ high: 90 })];
    const result = validateCandles(candles);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('rejects high < close', () => {
    const candles = [candle({ high: 90, close: 95 })];
    const result = validateCandles(candles);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('rejects low > open', () => {
    const candles = [candle({ low: 110 })];
    const result = validateCandles(candles);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('rejects low > close', () => {
    const candles = [candle({ low: 106, close: 105 })];
    const result = validateCandles(candles);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('rejects high < low', () => {
    const candles = [candle({ high: 80, low: 100 })];
    const result = validateCandles(candles);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('rejects negative price', () => {
    const candles = [candle({ open: -1 })];
    const result = validateCandles(candles);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('rejects negative volume', () => {
    const candles = [candle({ volume: -100 })];
    const result = validateCandles(candles);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('rejects duplicate dates', () => {
    const candles = [
      candle({ time: '2021-06-21' }),
      candle({ time: '2021-06-21' }),
    ];
    const result = validateCandles(candles);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('warns about weekend dates', () => {
    const candles = [candle({ time: '2021-06-19' })]; // Saturday
    const result = validateCandles(candles);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0].message).toContain('非交易日');
  });

  it('warns about adjacent duplicate OHLC', () => {
    const candles = [
      candle({ time: '2021-06-21' }),
      candle({ time: '2021-06-22' }),
    ];
    const result = validateCandles(candles);
    const adjWarnings = result.warnings.filter((w) =>
      w.message.includes('完全一致'),
    );
    expect(adjWarnings.length).toBeGreaterThan(0);
  });

  it('rejects out-of-order dates', () => {
    const candles = [
      candle({ time: '2021-06-22' }),
      candle({ time: '2021-06-21' }),
    ];
    const result = validateCandles(candles);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
