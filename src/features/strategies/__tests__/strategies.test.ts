import { describe, it, expect } from 'vitest';
import { dualMaStrategy } from '../builtins/dualMa';
import { rsiStrategy } from '../builtins/rsiStrategy';
import { macdStrategy } from '../builtins/macdStrategy';
import { bollStrategy } from '../builtins/bollStrategy';
import { createContext } from '../types';
import type { Candle } from '@/models';

function candlesFromCloses(closes: number[]): Candle[] {
  return closes.map((close, i) => ({
    time: `2021-01-${String(i + 1).padStart(2, '0')}`,
    symbol: 'TEST',
    open: close - 0.5,
    high: close + 1,
    low: close - 1,
    close,
    volume: 1000000,
  }));
}

const noPosition = { quantity: 0, avgCost: 0 };
const hasPosition = { quantity: 100, avgCost: 10 };

describe('Dual MA Strategy', () => {
  it('generates buy on golden cross', () => {
    // Flat for first 20 bars, then sharp rise — short MA crosses above long MA
    const closes = Array.from({ length: 30 }, (_, i) => i < 20 ? 10 : 10 + (i - 19) * 2);
    const candles = candlesFromCloses(closes);
    const params = { shortPeriod: 5, longPeriod: 20 };

    let foundBuy = false;
    for (let i = params.longPeriod; i < candles.length; i++) {
      const ctx = createContext(i, candles, {}, noPosition);
      const signal = dualMaStrategy.evaluate(ctx, params);
      if (signal.action === 'buy') {
        foundBuy = true;
        break;
      }
    }
    expect(foundBuy).toBe(true);
  });

  it('generates sell on dead cross', () => {
    // High plateau then sharp decline — short MA crosses below long MA
    const closes = Array.from({ length: 35 }, (_, i) => i < 20 ? 30 : 30 - (i - 19) * 2);
    const candles = candlesFromCloses(closes);
    const params = { shortPeriod: 5, longPeriod: 20 };

    let foundSell = false;
    for (let i = params.longPeriod; i < candles.length; i++) {
      const ctx = createContext(i, candles, {}, hasPosition);
      const signal = dualMaStrategy.evaluate(ctx, params);
      if (signal.action === 'sell') {
        foundSell = true;
        break;
      }
    }
    expect(foundSell).toBe(true);
  });

  it('returns hold during warmup', () => {
    const candles = candlesFromCloses([10, 11, 12, 13, 14]);
    const params = { shortPeriod: 5, longPeriod: 10 };
    const ctx = createContext(0, candles, {}, noPosition);
    const signal = dualMaStrategy.evaluate(ctx, params);
    expect(signal.action).toBe('hold');
  });

  it('ignores buy signal when already holding', () => {
    const closes = [10, 10.2, 10.4, 10.6, 10.8, 11, 11.5, 12, 12.5, 13, 13.5, 14, 14.5, 15, 15.5, 16, 16.5, 17, 17.5, 18, 19, 20, 21, 22, 23];
    const candles = candlesFromCloses(closes);
    const params = { shortPeriod: 5, longPeriod: 20 };

    for (let i = params.longPeriod; i < candles.length; i++) {
      const ctx = createContext(i, candles, {}, hasPosition);
      const signal = dualMaStrategy.evaluate(ctx, params);
      expect(signal.action).not.toBe('buy');
    }
  });
});

describe('RSI Strategy', () => {
  it('returns hold during warmup', () => {
    const candles = candlesFromCloses([10, 11, 12]);
    const params = { period: 14, oversold: 30, overbought: 70 };
    const ctx = createContext(0, candles, {}, noPosition);
    const signal = rsiStrategy.evaluate(ctx, params);
    expect(signal.action).toBe('hold');
  });

  it('generates valid signals only', () => {
    const closes = Array.from({ length: 50 }, (_, i) => 100 + Math.sin(i * 0.3) * 20);
    const candles = candlesFromCloses(closes);
    const params = { period: 14, oversold: 30, overbought: 70 };

    for (let i = params.period + 1; i < candles.length; i++) {
      const ctx = createContext(i, candles, {}, noPosition);
      const signal = rsiStrategy.evaluate(ctx, params);
      expect(['buy', 'sell', 'hold']).toContain(signal.action);
    }
  });

  it('does not generate duplicate buy signals', () => {
    const closes = Array.from({ length: 50 }, (_, i) => 100 + Math.sin(i * 0.3) * 20);
    const candles = candlesFromCloses(closes);
    const params = { period: 14, oversold: 30, overbought: 70 };

    let buyCount = 0;
    for (let i = params.period + 1; i < candles.length; i++) {
      const ctx = createContext(i, candles, {}, hasPosition);
      const signal = rsiStrategy.evaluate(ctx, params);
      if (signal.action === 'buy') buyCount++;
    }
    expect(buyCount).toBe(0); // No buys when already holding
  });
});

describe('MACD Strategy', () => {
  it('returns hold during warmup', () => {
    const candles = candlesFromCloses([10, 11, 12]);
    const params = { fast: 12, slow: 26, signal: 9 };
    const ctx = createContext(0, candles, {}, noPosition);
    const signal = macdStrategy.evaluate(ctx, params);
    expect(signal.action).toBe('hold');
  });

  it('generates deterministic signals for fixed input', () => {
    const closes = [1, 2, 4, 8, 16, 8, 4, 2, 1, 2, 4, 8, 16, 8, 4, 2, 1, 2, 4, 8, 16, 8, 4, 2, 1, 2, 4, 8, 16, 8, 4, 2, 1, 2, 4, 8, 16, 8, 4, 2, 1];
    const candles = candlesFromCloses(closes);
    const params = { fast: 3, slow: 5, signal: 2 };

    // Run twice and compare
    const signals1: string[] = [];
    const signals2: string[] = [];

    for (let i = params.slow + params.signal; i < candles.length; i++) {
      const ctx = createContext(i, candles, {}, noPosition);
      signals1.push(macdStrategy.evaluate(ctx, params).action);
    }
    for (let i = params.slow + params.signal; i < candles.length; i++) {
      const ctx = createContext(i, candles, {}, noPosition);
      signals2.push(macdStrategy.evaluate(ctx, params).action);
    }
    expect(signals1).toEqual(signals2);
  });

  it('ignores sell signal when not holding', () => {
    const closes = [1, 2, 4, 8, 16, 8, 4, 2, 1, 2, 4, 8, 16, 8, 4, 2, 1, 2, 4, 8, 16, 8, 4, 2, 1, 2, 4, 8, 16, 8, 4, 2, 1, 2, 4, 8, 16, 8, 4, 2, 1];
    const candles = candlesFromCloses(closes);
    const params = { fast: 3, slow: 5, signal: 2 };

    for (let i = params.slow + params.signal; i < candles.length; i++) {
      const ctx = createContext(i, candles, {}, noPosition);
      const signal = macdStrategy.evaluate(ctx, params);
      expect(signal.action).not.toBe('sell');
    }
  });
});

describe('BOLL Strategy', () => {
  it('returns hold during warmup', () => {
    const candles = candlesFromCloses([10, 11, 12]);
    const params = { period: 20, stdDev: 2 };
    const ctx = createContext(0, candles, {}, noPosition);
    const signal = bollStrategy.evaluate(ctx, params);
    expect(signal.action).toBe('hold');
  });

  it('generates valid signals only', () => {
    const closes = Array.from({ length: 50 }, (_, i) => 100 + Math.sin(i * 0.2) * 30);
    const candles = candlesFromCloses(closes);
    const params = { period: 20, stdDev: 2 };

    for (let i = params.period; i < candles.length; i++) {
      const ctx = createContext(i, candles, {}, noPosition);
      const signal = bollStrategy.evaluate(ctx, params);
      expect(['buy', 'sell', 'hold']).toContain(signal.action);
    }
  });

  it('does not generate buy when already holding', () => {
    const closes = Array.from({ length: 50 }, (_, i) => 100 + Math.sin(i * 0.2) * 30);
    const candles = candlesFromCloses(closes);
    const params = { period: 20, stdDev: 2 };

    for (let i = params.period; i < candles.length; i++) {
      const ctx = createContext(i, candles, {}, hasPosition);
      const signal = bollStrategy.evaluate(ctx, params);
      expect(signal.action).not.toBe('buy');
    }
  });
});

describe('Strategy determinism', () => {
  it.each([dualMaStrategy, rsiStrategy, macdStrategy, bollStrategy])(
    '%s produces identical output for identical input',
    (strategy) => {
      const closes = Array.from({ length: 50 }, (_, i) => 50 + i * 0.5 + Math.sin(i * 0.5) * 5);
      const candles = candlesFromCloses(closes);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const params = { ...(strategy as any).defaultParams };

      const results1: string[] = [];
      const results2: string[] = [];

      const warmup = strategy.warmupBars(params);
      for (let i = warmup; i < candles.length; i++) {
        const ctx = createContext(i, candles, {}, noPosition);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        results1.push((strategy.evaluate as any)(ctx, params).action);
      }
      for (let i = warmup; i < candles.length; i++) {
        const ctx = createContext(i, candles, {}, noPosition);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        results2.push((strategy.evaluate as any)(ctx, params).action);
      }

      expect(results1).toEqual(results2);
    },
  );
});
