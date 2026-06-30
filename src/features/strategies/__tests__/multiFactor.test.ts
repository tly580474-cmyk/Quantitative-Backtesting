import { describe, expect, it } from 'vitest';
import type { Candle, StrategyDefinition } from '@/models';
import { createContext } from '../types';
import {
  calculateReversalComposite,
  calculateVolatilityComposite,
  REVERSAL_WEIGHTS,
  rollingZScore,
  VOLATILITY_WEIGHTS,
} from '../multiFactor';
import { compositeFactorStrategy } from '../builtins/compositeFactorStrategy';
import { reversalStrategy } from '../builtins/reversalStrategy';
import { volatilityStrategy } from '../builtins/volatilityStrategy';

function makeCandles(length: number): Candle[] {
  return Array.from({ length }, (_, index) => {
    const close = 100
      + index * 0.03
      + Math.sin(index * 0.19) * 6
      + Math.sin(index * 0.047) * 12;
    return {
      time: `2024-${String(Math.floor(index / 28) + 1).padStart(2, '0')}-${String(index % 28 + 1).padStart(2, '0')}`,
      symbol: 'TEST',
      open: close * 0.999,
      high: close * 1.01,
      low: close * 0.99,
      close,
      volume: 1_000_000,
    };
  });
}

const noPosition = { quantity: 0, avgCost: 0 };

describe('multi-factor calculations', () => {
  it('uses the configured weights from the strategy specification', () => {
    expect(VOLATILITY_WEIGHTS).toEqual({
      vol_5: 0.5,
      vol_10: 0.15,
      vol_20: 0.35,
    });
    expect(Object.values(REVERSAL_WEIGHTS).reduce((sum, weight) => sum + weight, 0))
      .toBeCloseTo(1, 12);
  });

  it('calculates a rolling Z-score without future data', () => {
    const full = rollingZScore([1, 2, 3, 4, 100], 3);
    const prefix = rollingZScore([1, 2, 3, 4], 3);
    expect(full.slice(0, 4)).toEqual(prefix);
    expect(full[0]).toBeNull();
    expect(full[1]).toBeNull();
    expect(full[2]).toBeCloseTo(1);
  });

  it('keeps both composites point-in-time stable when future bars are appended', () => {
    const candles = makeCandles(150);
    const prefix = candles.slice(0, 140);
    const volatilityFull = calculateVolatilityComposite(candles, 60).score;
    const volatilityPrefix = calculateVolatilityComposite(prefix, 60).score;
    const reversalFull = calculateReversalComposite(candles, 60).score;
    const reversalPrefix = calculateReversalComposite(prefix, 60).score;

    expect(volatilityFull.slice(0, prefix.length)).toEqual(volatilityPrefix);
    expect(reversalFull.slice(0, prefix.length)).toEqual(reversalPrefix);
    expect(volatilityPrefix[volatilityPrefix.length - 1]).not.toBeNull();
    expect(reversalPrefix[reversalPrefix.length - 1]).not.toBeNull();
  });
});

describe('multi-factor strategies', () => {
  const strategies: StrategyDefinition[] = [
    volatilityStrategy,
    reversalStrategy,
    compositeFactorStrategy,
  ];

  it.each(strategies)('$name is deterministic', (strategy) => {
    const candles = makeCandles(150);
    const context = createContext(candles.length - 1, candles, {}, noPosition);
    const params = strategy.defaultParams;
    expect(strategy.evaluate(context, params)).toEqual(strategy.evaluate(context, params));
  });

  it('applies the optional 15% peak-to-close stop loss before factor warmup', () => {
    const candles: Candle[] = [100, 110, 108, 90].map((close, index) => ({
      time: `2024-01-0${index + 1}`,
      symbol: 'TEST',
      open: close,
      high: close,
      low: close,
      close,
      volume: 1000,
    }));
    const context = createContext(candles.length - 1, candles, {}, {
      quantity: 100,
      avgCost: 100,
      entryTime: candles[0].time,
    });
    const signal = compositeFactorStrategy.evaluate(context, {
      zScoreWindow: 60,
      stopLossEnabled: true,
      stopLossPercent: 15,
    });

    expect(signal.action).toBe('sell');
    expect(signal.reason).toContain('触发 15% 止损');
  });
});
