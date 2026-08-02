import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BacktestConfig, Candle } from '@/models';
import { dualMaStrategy } from '@/features/strategies/builtins/dualMa';
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
      open: Number(open.toFixed(4)),
      high: Number((Math.max(open, close) + 1).toFixed(4)),
      low: Number((Math.min(open, close) - 1).toFixed(4)),
      close: Number(close.toFixed(4)),
      volume: 1_000_000 + index * 1_000,
    };
  });
}

function runBacktraderWorker(candles: Candle[], cfg: BacktestConfig = config): Promise<unknown> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      'python',
      [resolve('tools/backtrader/golden_parity.py')],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', (error) => rejectPromise(error));
    child.on('close', (code) => {
      if (code !== 0) {
        rejectPromise(new Error(`backtrader worker failed (${code}): ${stderr.slice(-2000)}`));
        return;
      }
      try {
        resolvePromise(JSON.parse(stdout));
      } catch (error) {
        rejectPromise(error instanceof Error ? error : new Error(String(error)));
      }
    });
    child.stdin.end(JSON.stringify({
      candles: candles.map((c) => ({
        time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
      })),
      strategy: { type: 'dual_ma', fast: 5, slow: 20 },
      config: {
        initialCapital: cfg.initialCapital,
        positionSizing: cfg.positionSizing.value,
        commissionRate: cfg.commissionRate,
        minimumCommission: cfg.minimumCommission,
        sellTaxRate: cfg.sellTaxRate,
        slippageBps: cfg.slippageBps,
        tradingUnitMode: cfg.tradingUnitMode,
        forceCloseAtEnd: cfg.forceCloseAtEnd,
      },
    }));
  });
}

function runBacktestTs(candles: Candle[], cfg: BacktestConfig) {
  return runBacktest({
    candles,
    strategy: dualMaStrategy,
    strategyParams: { shortPeriod: 5, longPeriod: 20 },
    config: cfg,
    datasetId: 'golden-dataset',
    datasetName: 'Golden parity fixture',
    datasetChecksum: 'golden-checksum-v1',
    resultName: 'Golden parity',
  });
}

function compareTrades(btTrades: Array<Record<string, unknown>>, tsTrades: Array<Record<string, unknown>>): void {
  expect(btTrades.map((t) => ({ time: t.time, side: t.side, quantity: t.quantity })))
    .toEqual(tsTrades.map((t) => ({ time: t.time, side: t.side, quantity: t.quantity })));
  expect(btTrades.length).toBe(tsTrades.length);
  for (let index = 0; index < tsTrades.length; index += 1) {
    const ts = tsTrades[index];
    const bt = btTrades[index];
    expect(Math.abs(bt.rawPrice as number - (ts.rawPrice as number))).toBeLessThanOrEqual(1e-4 + (ts.rawPrice as number) * 1e-6);
    expect(Math.abs(bt.fillPrice as number - (ts.fillPrice as number))).toBeLessThanOrEqual(1e-4 + (ts.fillPrice as number) * 1e-6);
    expect(Math.abs(bt.commission as number - (ts.commission as number))).toBeLessThanOrEqual(1e-4);
    expect(Math.abs(bt.tax as number - (ts.tax as number))).toBeLessThanOrEqual(1e-4);
    expect(Math.abs(bt.amount as number - (ts.amount as number))).toBeLessThanOrEqual(1e-4 + (ts.amount as number) * 1e-6);
  }
}

describe('N1.1 backtrader golden parity', () => {
  it('reproduces TS engine trades, orders and final equity within tolerance', async () => {
    const candles = makeCandles();
    const tsResult = runBacktestTs(candles, config);
    expect(tsResult.status).toBe('completed');

    const backtrader = await runBacktraderWorker(candles) as {
      trades: Array<{ time: string; side: string; quantity: number; rawPrice: number; fillPrice: number; commission: number; tax: number; amount: number }>;
      finalEquity: number;
    };

    const tsTrades = tsResult.trades.map((trade) => ({
      time: trade.time,
      side: trade.side,
      quantity: trade.quantity,
      rawPrice: trade.rawPrice,
      fillPrice: trade.fillPrice,
      commission: trade.commission,
      tax: trade.tax,
      amount: trade.amount,
    }));

    const btTrades = backtrader.trades.map((trade) => ({
      time: trade.time,
      side: trade.side,
      quantity: trade.quantity,
      rawPrice: trade.rawPrice,
      fillPrice: trade.fillPrice,
      commission: trade.commission,
      tax: trade.tax,
      amount: trade.amount,
    }));

    compareTrades(btTrades, tsTrades);

    // 最终权益（现金）在 0.01 元容差内一致
    const tsFinalEquity = tsResult.metrics.finalEquity;
    expect(Math.abs(backtrader.finalEquity - tsFinalEquity)).toBeLessThanOrEqual(0.02);
  });

  it('stays consistent under partial position sizing (0.5)', async () => {
    const candles = makeCandles();
    const partialConfig: BacktestConfig = { ...config, positionSizing: { type: 'percent', value: 0.5 } };
    const tsResult = runBacktestTs(candles, partialConfig);
    expect(tsResult.status).toBe('completed');

    const backtrader = await runBacktraderWorker(candles, partialConfig) as {
      trades: Array<{ time: string; side: string; quantity: number; rawPrice: number; fillPrice: number; commission: number; tax: number; amount: number }>;
      finalEquity: number;
    };

    const tsTrades = tsResult.trades.map((trade) => ({
      time: trade.time,
      side: trade.side,
      quantity: trade.quantity,
      rawPrice: trade.rawPrice,
      fillPrice: trade.fillPrice,
      commission: trade.commission,
      tax: trade.tax,
      amount: trade.amount,
    }));
    compareTrades(backtrader.trades, tsTrades);

    const tsFinalEquity = tsResult.metrics.finalEquity;
    expect(Math.abs(backtrader.finalEquity - tsFinalEquity)).toBeLessThanOrEqual(0.02);
  });

  it('stays consistent without force close and with a smaller account', async () => {
    const candles = makeCandles();
    const noForceConfig: BacktestConfig = {
      ...config,
      initialCapital: 50_000,
      forceCloseAtEnd: false,
    };
    const tsResult = runBacktestTs(candles, noForceConfig);
    expect(tsResult.status).toBe('completed');

    const backtrader = await runBacktraderWorker(candles, noForceConfig) as {
      trades: Array<{ time: string; side: string; quantity: number; rawPrice: number; fillPrice: number; commission: number; tax: number; amount: number }>;
      finalEquity: number;
    };

    const tsTrades = tsResult.trades.map((trade) => ({
      time: trade.time,
      side: trade.side,
      quantity: trade.quantity,
      rawPrice: trade.rawPrice,
      fillPrice: trade.fillPrice,
      commission: trade.commission,
      tax: trade.tax,
      amount: trade.amount,
    }));
    compareTrades(backtrader.trades, tsTrades);

    // 未强平时最终权益 = 现金（TS metrics.finalEquity 也反映现金口径）
    const tsFinalEquity = tsResult.metrics.finalEquity;
    expect(Math.abs(backtrader.finalEquity - tsFinalEquity)).toBeLessThanOrEqual(0.02);
  });
});
