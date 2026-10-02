import { describe, expect, it } from 'vitest';
import { calculateSupertrend, resolveSupertrendParams, SUPERTREND_PRESETS } from '../supertrend';
import { calculateAllIndicators } from '../calculator';
import { getIndicatorById } from '../registry';
import { aggregateCandles } from '@/features/chart/timeframe';

const flat = { open: 10, high: 11, low: 9, close: 10 };
const bars = [flat, flat, flat,
  { open: 9, high: 10, low: 8, close: 9 },
  { open: 20, high: 21, low: 19, close: 20 },
  { open: 4, high: 5, low: 3, close: 4 },
];

describe('Supertrend', () => {
  it('matches a hand-calculated Wilder ATR / trailing-band fixture with gaps in both directions', () => {
    const result = calculateSupertrend(bars, { period: 3, multiplier: 2 });
    expect(result.value.slice(0, 2)).toEqual([null, null]);
    expect(result.direction).toEqual([null, null, -1, -1, 1, -1]);
    const expectedAtr = [2, 2, 16 / 3, 83 / 9];
    const expectedBand = [14, 13, 28 / 3, 202 / 9];
    for (let index = 2; index < bars.length; index++) {
      expect(result.atr[index]).toBeCloseTo(expectedAtr[index - 2], 12);
      expect(result.value[index]).toBeCloseTo(expectedBand[index - 2], 12);
    }
    // Neither a narrow high-low range nor the expanded new basic band may
    // hide a gap through the carried stop. The gap must enter the ATR once.
    expect(result.atr[4]).toBeGreaterThan(bars[4].high - bars[4].low);
    expect(result.up[4]).toBeCloseTo(28 / 3);
    expect(result.down[4]).toBeNull();
    expect(result.up[5]).toBeNull();
  });

  it('does not flip on a wick through the band or a close equal to the band', () => {
    const wick = calculateSupertrend([...bars.slice(0, 3), { open: 10, high: 16, low: 9, close: 10 }], { period: 3, multiplier: 2 });
    expect(wick.direction[3]).toBe(-1);
    expect(wick.value[3]).toBe(14);
    const equal = calculateSupertrend([...bars.slice(0, 3), { open: 14, high: 15, low: 13, close: 14 }], { period: 3, multiplier: 2 });
    expect(equal.direction[3]).toBe(-1);
  });

  it('preserves every past result as future candles are revealed', () => {
    const all = calculateSupertrend(bars, { period: 3, multiplier: 2 });
    for (let length = 0; length <= bars.length; length++) {
      const prefix = calculateSupertrend(bars.slice(0, length), { period: 3, multiplier: 2 });
      for (const key of ['value', 'direction', 'up', 'down', 'atr'] as const) {
        expect(prefix[key]).toEqual(all[key].slice(0, length));
      }
    }
  });

  it('keeps each support/resistance trailing in its trend direction', () => {
    const sequence = Array.from({ length: 120 }, (_, index) => {
      const close = 20 + Math.sin(index / 8) * 8;
      return { open: close - 0.2, high: close + 1, low: close - 1, close };
    });
    const result = calculateSupertrend(sequence, { period: 5, multiplier: 1.5 });
    for (let index = 1; index < sequence.length; index++) {
      if (result.direction[index] == null || result.direction[index] !== result.direction[index - 1]) continue;
      if (result.direction[index] === 1) expect(result.value[index]!).toBeGreaterThanOrEqual(result.value[index - 1]!);
      else expect(result.value[index]!).toBeLessThanOrEqual(result.value[index - 1]!);
    }
  });

  it('has no invented warmup values and handles flat prices, invalid bars, and invalid parameters', () => {
    expect(calculateSupertrend([]).value).toEqual([]);
    expect(calculateSupertrend([flat]).value).toEqual([null]);
    expect(calculateSupertrend(Array(12).fill({ open: 10, high: 10, low: 10, close: 10 })).value[9]).toBe(10);
    const result = calculateSupertrend([...bars.slice(0, 3), { ...flat, high: NaN }, flat, flat, flat], { period: 3, multiplier: 2 });
    expect(result.value.slice(3, 6)).toEqual([null, null, null]);
    expect(result.value[6]).toBe(14);
    expect(() => calculateSupertrend(bars, { period: 0, multiplier: 2 })).toThrow(RangeError);
    expect(() => calculateSupertrend(bars, { period: 3.5, multiplier: 2 })).toThrow(RangeError);
    expect(() => calculateSupertrend(bars, { period: 3, multiplier: NaN })).toThrow(RangeError);
  });

  it('covers every timeframe and allows an explicit manual override', () => {
    for (const timeframe of Object.keys(SUPERTREND_PRESETS) as (keyof typeof SUPERTREND_PRESETS)[]) {
      expect(resolveSupertrendParams(timeframe)).toEqual(SUPERTREND_PRESETS[timeframe]);
      expect(resolveSupertrendParams(timeframe, { auto: 0, period: 7, multiplier: 1.8 })).toEqual({ period: 7, multiplier: 1.8 });
    }
    expect(resolveSupertrendParams('minute15')).toEqual({ period: 10, multiplier: 3 });
    expect(resolveSupertrendParams('year')).not.toEqual(resolveSupertrendParams('minute1'));
  });

  it('uses aggregated chart bars and their price basis, ignoring raw previousClose and calendar gaps', () => {
    const candles = Array.from({ length: 40 }, (_, index) => ({
      ...bars[index % bars.length], symbol: 'test',
      time: new Date(Date.UTC(2025, 0, 1 + index * 3)).toISOString().slice(0, 10),
      previousClose: 10000,
    }));
    const definition = getIndicatorById('supertrend')!;
    const active = { id: definition.id, definition, paramValues: { auto: 1 }, visible: true };
    const weekly = aggregateCandles(candles, 'week');
    const expected = calculateSupertrend(weekly, resolveSupertrendParams('week'));
    expect(calculateAllIndicators(weekly, [active], 'week')[0].series).toEqual({ up: expected.up, down: expected.down });
    expect(calculateAllIndicators(weekly, [{ ...active, visible: false }], 'week')).toEqual([]);
    expect(calculateSupertrend(candles).atr).toEqual(calculateSupertrend(candles.map(({ previousClose: _raw, ...bar }) => bar)).atr);
  });
});
