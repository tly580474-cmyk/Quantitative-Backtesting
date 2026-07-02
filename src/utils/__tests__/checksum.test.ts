import { describe, it, expect } from 'vitest';
import { computeDataChecksum, computeConfigHash, computeCombinedHash } from '../checksum';
import type { Candle } from '@/models';

function makeCandle(overrides: Partial<Candle> = {}): Candle {
  return {
    time: '2021-01-01',
    symbol: 'TEST',
    open: 10,
    high: 11,
    low: 9,
    close: 10.5,
    ...overrides,
  };
}

describe('computeDataChecksum', () => {
  it('returns consistent hash for identical candles', () => {
    const candles = [makeCandle(), makeCandle({ time: '2021-01-02' })];
    expect(computeDataChecksum(candles)).toBe(computeDataChecksum(candles));
  });

  it('produces different hash for different data', () => {
    const a = [makeCandle({ close: 10 })];
    const b = [makeCandle({ close: 11 })];
    expect(computeDataChecksum(a)).not.toBe(computeDataChecksum(b));
  });

  it('returns consistent hash for empty array', () => {
    expect(computeDataChecksum([])).toBe('0');
  });

  it('returns a non-empty string for valid input', () => {
    const result = computeDataChecksum([makeCandle()]);
    expect(result).toBeTruthy();
    expect(typeof result).toBe('string');
  });

  it('keeps the legacy checksum when turnover rate is absent', () => {
    expect(computeDataChecksum([makeCandle()])).toBe('-75694ba5');
  });

  it('is sensitive to volume changes', () => {
    const a = [makeCandle({ volume: 1000 })];
    const b = [makeCandle({ volume: 2000 })];
    expect(computeDataChecksum(a)).not.toBe(computeDataChecksum(b));
  });

  it('is sensitive to turnover-rate changes', () => {
    const a = [makeCandle({ turnoverRatePct: 1.2 })];
    const b = [makeCandle({ turnoverRatePct: 3.4 })];
    expect(computeDataChecksum(a)).not.toBe(computeDataChecksum(b));
  });
});

describe('computeConfigHash', () => {
  it('returns consistent hash for same object', () => {
    const obj = { a: 1, b: 'test' };
    expect(computeConfigHash(obj)).toBe(computeConfigHash(obj));
  });

  it('is key-order independent', () => {
    const a = { a: 1, b: 2 };
    const b = { b: 2, a: 1 };
    expect(computeConfigHash(a)).toBe(computeConfigHash(b));
  });

  it('produces different hashes for different values', () => {
    expect(computeConfigHash({ x: 1 })).not.toBe(computeConfigHash({ x: 2 }));
  });

  it('handles nested objects', () => {
    const a = { outer: { inner: 1 } };
    expect(computeConfigHash(a)).toBe(computeConfigHash(a));
  });
});

describe('computeCombinedHash', () => {
  it('is order-independent given sorted keys', () => {
    const a = computeCombinedHash({ x: 'a', y: 'b' });
    const b = computeCombinedHash({ y: 'b', x: 'a' });
    expect(a).toBe(b);
  });
});
