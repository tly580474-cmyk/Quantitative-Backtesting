import { describe, expect, it } from 'vitest';
import { getStrategyById } from '../registry';
import type { Candle, PositionSnapshot } from '@/models';

describe('Chan center breakout backtest adapter', () => {
  it('is registered and returns a hold signal while no confirmed center departure exists', () => {
    const strategy = getStrategyById('chanCenterBreakout');
    const candles: Candle[] = Array.from({ length: 7 }, (_, index) => ({
      time: `2026-07-${String(index + 1).padStart(2, '0')}`,
      symbol: 'TEST',
      open: 10 + index,
      high: 11 + index,
      low: 9 + index,
      close: 10.5 + index,
    }));
    const position: PositionSnapshot = {
      quantity: 0,
      avgCost: 0,
    };

    expect(strategy).toBeDefined();
    expect(strategy!.evaluate({ index: 6, candles, indicators: {}, position }, { level: 'pen' }))
      .toMatchObject({ time: candles[6].time, action: 'hold' });
  });
});
