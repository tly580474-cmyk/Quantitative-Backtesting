import { describe, expect, it } from 'vitest';
import type { BacktestConfig, Candle } from '@/models';
import { dualMaStrategy } from '@/features/strategies/builtins/dualMa';
import { compileAndValidate } from '@/features/visualStrategies/compiler';
import type { VisualStrategyDocument } from '@/features/visualStrategies/types';
import { runBacktest } from '../engine';

const config: BacktestConfig = {
  backtestMode: 'strategy',
  initialCapital: 100_000,
  tradingDays: 0,
  positionSizing: { type: 'percent', value: 1 },
  commissionRate: 0.0003,
  minimumCommission: 5,
  sellTaxRate: 0.001,
  slippageBps: 3,
  tradingUnitMode: 'stock',
  minimumTradeAmount: 1,
  dca: { amount: 1_000, frequency: 'monthly' },
  execution: 'next_open',
  forceCloseAtEnd: true,
};

function makeCandles(): Candle[] {
  const start = Date.UTC(2025, 0, 2);
  return Array.from({ length: 180 }, (_, index) => {
    const close = 100 + Math.sin(index / 7) * 14 + index * 0.03;
    const open = close + ((index % 5) - 2) * 0.08;
    return {
      time: new Date(start + index * 86_400_000).toISOString().slice(0, 10),
      symbol: 'GOLDEN',
      open,
      high: Math.max(open, close) + 1,
      low: Math.min(open, close) - 1,
      close,
      volume: 1_000_000 + index * 1_000,
    };
  });
}

function agentDualMaDocument(): VisualStrategyDocument {
  return {
    schemaVersion: '1.0',
    id: 'agent-dual-ma',
    name: 'Agent 双均线',
    description: '与 UI 内置双均线相同的 Agent DSL',
    strategyVersion: 1,
    parameters: [],
    indicators: [{
      id: 'ma',
      indicatorId: 'sma',
      params: { period1: 5, period2: 20 },
      outputs: [
        { key: 'sma1', label: 'SMA5', type: 'number' },
        { key: 'sma2', label: 'SMA20', type: 'number' },
      ],
    }],
    entry: {
      type: 'group',
      id: 'entry',
      operator: 'all',
      children: [{
        type: 'condition',
        id: 'golden-cross',
        left: { type: 'indicator', nodeId: 'ma', output: 'sma1', offset: 0 },
        operator: 'crossesAbove',
        right: { type: 'indicator', nodeId: 'ma', output: 'sma2', offset: 0 },
      }],
    },
    exit: {
      type: 'group',
      id: 'exit',
      operator: 'all',
      children: [{
        type: 'condition',
        id: 'dead-cross',
        left: { type: 'indicator', nodeId: 'ma', output: 'sma1', offset: 0 },
        operator: 'crossesBelow',
        right: { type: 'indicator', nodeId: 'ma', output: 'sma2', offset: 0 },
      }],
    },
    risk: [],
    metadata: {
      source: 'ai',
      createdAt: '2026-07-31T00:00:00.000Z',
      updatedAt: '2026-07-31T00:00:00.000Z',
    },
  };
}

describe('single-instrument Agent/UI golden parity gate', () => {
  it('produces exactly the same executable signals, trades, equity and metrics', () => {
    const candles = makeCandles();
    const compiled = compileAndValidate(agentDualMaDocument());
    expect(compiled.success).toBe(true);
    if (!compiled.success) return;

    const common = {
      candles,
      config,
      datasetId: 'golden-dataset',
      datasetName: 'Golden parity fixture',
      datasetChecksum: 'golden-checksum-v1',
      resultName: 'Golden parity',
    };
    const uiResult = runBacktest({
      ...common,
      strategy: dualMaStrategy,
      strategyParams: { shortPeriod: 5, longPeriod: 20 },
    });
    const agentResult = runBacktest({
      ...common,
      strategy: compiled.strategy,
      strategyParams: {},
    });

    const executableSignals = (result: typeof uiResult) => result.signals
      .filter((signal) => signal.action !== 'hold')
      .map(({ time, action }) => ({ time, action }));
    const trades = (result: typeof uiResult) => result.trades.map((trade) => ({
      time: trade.time,
      side: trade.side,
      quantity: trade.quantity,
      rawPrice: trade.rawPrice,
      fillPrice: trade.fillPrice,
      amount: trade.amount,
      commission: trade.commission,
      tax: trade.tax,
      slippageCost: trade.slippageCost,
      forceClose: trade.forceClose,
    }));

    expect(agentResult.status).toBe('completed');
    expect(executableSignals(agentResult)).toEqual(executableSignals(uiResult));
    expect(trades(agentResult)).toEqual(trades(uiResult));
    expect(agentResult.equityCurve).toEqual(uiResult.equityCurve);
    expect(agentResult.metrics).toEqual(uiResult.metrics);
  });
});
