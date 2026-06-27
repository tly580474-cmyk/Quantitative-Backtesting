import { describe, expect, it } from 'vitest';
import type { BacktestResult } from '@/models';
import { getResultStrategyName, inferResultStrategyName } from '../resultLabel';

function result(overrides: Partial<BacktestResult> = {}): BacktestResult {
  return {
    id: 'result-1',
    name: '932000 - RSI 超买超卖 - 2026/6/27 16:15:50',
    status: 'completed',
    datasetSnapshot: {
      id: 'dataset-1',
      symbol: '932000',
      startTime: '2026-01-01',
      endTime: '2026-06-01',
      checksum: 'checksum',
    },
    strategyId: 'rsi',
    strategyVersion: '1.0',
    strategyParams: {},
    config: {
      backtestMode: 'strategy',
      initialCapital: 100000,
      tradingDays: 0,
      positionSizing: { type: 'percent', value: 1 },
      commissionRate: 0,
      minimumCommission: 0,
      sellTaxRate: 0,
      slippageBps: 0,
      tradingUnitMode: 'index',
      minimumTradeAmount: 1,
      dca: { amount: 1000, frequency: 'monthly' },
      execution: 'next_open',
      forceCloseAtEnd: false,
    },
    startedAt: '2026-06-27T08:15:50.000Z',
    completedAt: '2026-06-27T08:15:51.000Z',
    metrics: {} as BacktestResult['metrics'],
    signals: [],
    trades: [],
    equityCurve: [],
    ...overrides,
  };
}

describe('backtest result strategy labels', () => {
  it('prefers a strategy name resolved from the strategy library', () => {
    expect(getResultStrategyName(result(), { rsi: 'RSI 超买超卖策略' }))
      .toBe('RSI 超买超卖策略');
  });

  it('reads the embedded strategy name from newly named results', () => {
    expect(inferResultStrategyName(result())).toBe('RSI 超买超卖');
  });

  it('labels DCA results consistently', () => {
    expect(inferResultStrategyName(result({
      strategyId: 'dca',
      config: { ...result().config, backtestMode: 'dca' },
    }))).toBe('定投策略');
  });
});
