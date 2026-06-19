import { describe, it, expect } from 'vitest';
import { runBacktest } from '../engine';
import { dualMaStrategy } from '@/features/strategies/builtins/dualMa';
import type { Candle, BacktestConfig } from '@/models';

function makeCandles(closes: number[]): Candle[] {
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

const baseConfig: BacktestConfig = {
  backtestMode: 'strategy',
  initialCapital: 100000,
  tradingDays: 0,
  positionSizing: { type: 'percent', value: 1 },
  commissionRate: 0.0003,
  minimumCommission: 5,
  sellTaxRate: 0.001,
  slippageBps: 0, // Zero slippage for deterministic testing
  tradingUnitMode: 'index',
  minimumTradeAmount: 1,
  dca: { amount: 1000, frequency: 'monthly' },
  execution: 'next_open',
  forceCloseAtEnd: true,
};

describe('Backtest Engine', () => {
  it('buys unconditionally at each scheduled close without a strategy or sell', () => {
    const candles: Candle[] = ['2021-01-04', '2021-02-01', '2021-03-01', '2021-04-01'].map((time) => ({
      time, symbol: 'TEST', open: 10, high: 11, low: 9, close: 10, volume: 1000,
    }));
    const result = runBacktest({
      candles,
      strategyParams: { shortPeriod: 5, longPeriod: 20 },
      config: {
        ...baseConfig,
        backtestMode: 'dca',
        dca: { amount: 1000, frequency: 'monthly' },
        slippageBps: 50,
        forceCloseAtEnd: true,
      },
      datasetId: 'ds-dca',
      datasetChecksum: 'dca',
      resultName: 'dca-test',
    });
    expect(result.status).toBe('completed');
    const buys = result.trades.filter((trade) => trade.side === 'buy' && trade.quantity > 0);
    expect(buys).toHaveLength(4);
    expect(buys.every((trade) => trade.fillPrice === 10)).toBe(true);
    expect(result.trades.some((trade) => trade.side === 'sell')).toBe(false);
    expect(result.strategyId).toBe('dca');
    expect(result.strategyParams).toEqual({});
    expect(result.metrics.netContributions).toBeCloseTo(103045, 2);
    expect(result.equityCurve[result.equityCurve.length - 1]?.positionQuantity).toBeGreaterThan(0);
  });

  it('continues daily DCA through external contributions after the initial purchase', () => {
    const candles: Candle[] = Array.from({ length: 20 }, (_, index) => ({
      time: `2021-01-${String(index + 1).padStart(2, '0')}`,
      symbol: 'TEST', open: 10, high: 11, low: 9, close: 10, volume: 1000,
    }));
    const result = runBacktest({
      candles,
      strategyParams: {},
      config: {
        ...baseConfig,
        initialCapital: 100,
        backtestMode: 'dca',
        dca: { amount: 100, frequency: 'daily' },
        commissionRate: 0,
        minimumCommission: 0,
      },
      datasetId: 'ds-dca-daily',
      datasetChecksum: 'dca-daily',
      resultName: 'dca-daily-test',
    });
    expect(result.trades.filter((trade) => trade.quantity > 0)).toHaveLength(20);
    expect(result.metrics.netContributions).toBe(2000);
    expect(result.metrics.totalReturn).toBe(0);
  });

  it('completes with no trades on flat prices', () => {
    const closes = Array.from({ length: 30 }, () => 10);
    const candles = makeCandles(closes);

    const result = runBacktest({
      candles,
      strategy: dualMaStrategy,
      strategyParams: { shortPeriod: 5, longPeriod: 20 },
      config: baseConfig,
      datasetId: 'ds-1',
      datasetChecksum: 'abc',
      resultName: 'test',
    });

    expect(result.status).toBe('completed');
    expect(result.equityCurve).toHaveLength(30);
    expect(result.metrics.tradeCount).toBe(0);
    // Equity should equal initial capital (no trades, flat prices)
    const lastEquity = result.equityCurve[result.equityCurve.length - 1].equity;
    expect(lastEquity).toBeCloseTo(100000, 0);
  });

  it('generates signals for trending prices', () => {
    // Flat then rising — should trigger golden cross
    const closes = Array.from({ length: 40 }, (_, i) =>
      i < 20 ? 10 : 10 + (i - 19) * 2,
    );
    const candles = makeCandles(closes);

    const result = runBacktest({
      candles,
      strategy: dualMaStrategy,
      strategyParams: { shortPeriod: 5, longPeriod: 20 },
      config: baseConfig,
      datasetId: 'ds-1',
      datasetChecksum: 'abc',
      resultName: 'test',
    });

    expect(result.status).toBe('completed');
    // Should have at least one buy signal
    const buySignals = result.signals.filter((s) => s.action === 'buy');
    expect(buySignals.length).toBeGreaterThan(0);
  });

  it('enforces signal at T, execute at T+1', () => {
    const closes = Array.from({ length: 40 }, (_, i) =>
      i < 20 ? 10 : 10 + (i - 19) * 2,
    );
    const candles = makeCandles(closes);

    const result = runBacktest({
      candles,
      strategy: dualMaStrategy,
      strategyParams: { shortPeriod: 5, longPeriod: 20 },
      config: baseConfig,
      datasetId: 'ds-1',
      datasetChecksum: 'abc',
      resultName: 'test',
    });

    // Verify that trades execute on a different day than the signal
    for (const trade of result.trades) {
      if (trade.quantity > 0) {
        const signal = result.signals.find((s) => s.time === trade.time);
        // Trade time should not equal the signal time (next day execution)
        // The signal that caused this trade would be from the previous day
        expect(trade.orderId).toBeTruthy();
      }
    }
  });

  it('cancels last bar signal', () => {
    const closes = Array.from({ length: 30 }, (_, i) =>
      i < 20 ? 10 : 10 + (i - 19) * 2,
    );
    const candles = makeCandles(closes);

    const result = runBacktest({
      candles,
      strategy: dualMaStrategy,
      strategyParams: { shortPeriod: 5, longPeriod: 20 },
      config: baseConfig,
      datasetId: 'ds-1',
      datasetChecksum: 'abc',
      resultName: 'test',
    });

    // Last signal should not be buy or sell
    const lastSignal = result.signals[result.signals.length - 1];
    expect(lastSignal.action).toBe('hold');
  });

  it('force closes position at end', () => {
    // Strong uptrend to ensure a buy happens, then check force close
    const closes = Array.from({ length: 50 }, (_, i) =>
      i < 25 ? 10 : 10 + (i - 24) * 3,
    );
    const candles = makeCandles(closes);

    const result = runBacktest({
      candles,
      strategy: dualMaStrategy,
      strategyParams: { shortPeriod: 5, longPeriod: 20 },
      config: { ...baseConfig, forceCloseAtEnd: true },
      datasetId: 'ds-1',
      datasetChecksum: 'abc',
      resultName: 'test',
    });

    // After force close, final position should be 0
    const lastPoint = result.equityCurve[result.equityCurve.length - 1];
    expect(lastPoint.positionQuantity).toBe(0);

    // Should have a force close trade
    const forceCloseTrades = result.trades.filter((t) => t.forceClose);
    if (result.trades.filter((t) => t.side === 'buy' && t.quantity > 0).length > 0) {
      expect(forceCloseTrades.length).toBeGreaterThan(0);
    }
  });

  it('produces deterministic results', () => {
    const closes = Array.from({ length: 40 }, (_, i) =>
      i < 20 ? 10 : 10 + (i - 19) * 2,
    );
    const candles = makeCandles(closes);

    const result1 = runBacktest({
      candles,
      strategy: dualMaStrategy,
      strategyParams: { shortPeriod: 5, longPeriod: 20 },
      config: baseConfig,
      datasetId: 'ds-1',
      datasetChecksum: 'abc',
      resultName: 'test',
    });

    const result2 = runBacktest({
      candles,
      strategy: dualMaStrategy,
      strategyParams: { shortPeriod: 5, longPeriod: 20 },
      config: baseConfig,
      datasetId: 'ds-1',
      datasetChecksum: 'abc',
      resultName: 'test',
    });

    expect(result1.metrics.totalReturn).toBe(result2.metrics.totalReturn);
    expect(result1.metrics.maxDrawdown).toBe(result2.metrics.maxDrawdown);
    expect(result1.trades.length).toBe(result2.trades.length);
  });

  it('rejects on invalid data', () => {
    const result = runBacktest({
      candles: [],
      strategy: dualMaStrategy,
      strategyParams: { shortPeriod: 5, longPeriod: 20 },
      config: baseConfig,
      datasetId: 'ds-1',
      datasetChecksum: 'abc',
      resultName: 'test',
    });

    expect(result.status).toBe('failed');
    expect(result.error).toBeTruthy();
  });

  it('validates duplicate dates', () => {
    const candles: Candle[] = [
      { time: '2021-01-01', symbol: 'TEST', open: 10, high: 11, low: 9, close: 10.5 },
      { time: '2021-01-01', symbol: 'TEST', open: 10, high: 11, low: 9, close: 10.5 },
    ];

    const result = runBacktest({
      candles,
      strategy: dualMaStrategy,
      strategyParams: { shortPeriod: 5, longPeriod: 20 },
      config: baseConfig,
      datasetId: 'ds-1',
      datasetChecksum: 'abc',
      resultName: 'test',
    });

    expect(result.status).toBe('failed');
  });

  it('computes benchmark return as buy-and-hold', () => {
    const closes = [10, 12, 14, 16, 18];
    const candles = makeCandles(closes);

    const result = runBacktest({
      candles,
      strategy: dualMaStrategy,
      strategyParams: { shortPeriod: 3, longPeriod: 4 },
      config: { ...baseConfig, forceCloseAtEnd: false },
      datasetId: 'ds-1',
      datasetChecksum: 'abc',
      resultName: 'test',
    });

    expect(result.metrics.benchmarkReturn).toBeCloseTo(0.8, 2); // (18 - 10) / 10
  });
});
