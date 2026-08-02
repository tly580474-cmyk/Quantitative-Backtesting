import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runEventEngine, eventEngineRequestSchema, type EventEngineRequest } from './eventEngineRuntime.js';

function makeCandles(): Array<{ time: string; open: number; high: number; low: number; close: number; volume: number }> {
  const start = Date.UTC(2025, 0, 2);
  return Array.from({ length: 120 }, (_, index) => {
    const close = 100 + Math.sin(index / 7) * 14 + index * 0.03;
    const open = close + ((index % 5) - 2) * 0.08;
    return {
      time: new Date(start + index * 86_400_000).toISOString().slice(0, 10),
      open: Number(open.toFixed(4)),
      high: Number((Math.max(open, close) + 1).toFixed(4)),
      low: Number((Math.min(open, close) - 1).toFixed(4)),
      close: Number(close.toFixed(4)),
      volume: 1_000_000 + index * 1_000,
    };
  });
}

function buildRequest(): EventEngineRequest {
  return {
    protocolVersion: '1.0',
    strategy: { type: 'dual_ma', params: { fast: 5, slow: 20 } },
    candles: makeCandles(),
    config: {
      initialCapital: 100_000,
      positionSizing: 1,
      commissionRate: 0.0003,
      minimumCommission: 5,
      sellTaxRate: 0.001,
      slippageBps: 3,
      tradingUnitMode: 'stock',
      minimumTradeAmount: 100,
      forceCloseAtEnd: true,
    },
  };
}

function makeIndexLikeCandles(): Array<{ time: string; open: number; high: number; low: number; close: number; volume: number }> {
  // 模拟指数点位（如中证全指 000985，数千点），股票 100 股整手永远无法成交
  const start = Date.UTC(2025, 0, 2);
  return Array.from({ length: 120 }, (_, index) => {
    const close = 4000 + Math.sin(index / 7) * 120 + index * 0.5;
    const open = close + ((index % 5) - 2) * 0.5;
    return {
      time: new Date(start + index * 86_400_000).toISOString().slice(0, 10),
      open: Number(open.toFixed(4)),
      high: Number((Math.max(open, close) + 1).toFixed(4)),
      low: Number((Math.min(open, close) - 1).toFixed(4)),
      close: Number(close.toFixed(4)),
      volume: 1_000_000 + index * 1_000,
    };
  });
}

describe('M5 event engine runtime (N1.2 backtrader adapter)', () => {
  it('is disabled unless explicitly enabled', async () => {
    await expect(runEventEngine({ request: buildRequest(), enabled: false, pythonExecutable: 'python' }))
      .rejects.toThrow('EVENT_ENGINE_RUNTIME_DISABLED');
  });

  it('rejects unknown strategy types through schema', () => {
    const request = buildRequest();
    expect(() => eventEngineRequestSchema.parse({
      ...request,
      strategy: { type: 'unknown_strategy', params: {} },
    })).toThrow();
  });

  it('runs the backtrader event engine and returns screening-only trades', async () => {
    const result = await runEventEngine({
      request: buildRequest(),
      enabled: true,
      pythonExecutable: 'python',
      workerPath: resolve('../tools/backtrader/event_engine_worker.py'),
    });
    expect(result.protocolVersion).toBe('1.0');
    expect(result.runtime).toBe('backtrader');
    expect(result.authority).toBe('screening_only');
    expect(result.publishable).toBe(false);
    expect(result.trades.length).toBeGreaterThan(0);
    expect(result.equityCurve.length).toBeGreaterThan(0);
    expect(result.finalEquity).toBeGreaterThan(0);
    // 全部成交记录必须为 screening_only 可追溯字段
    for (const trade of result.trades) {
      expect(trade.quantity).toBeGreaterThan(0);
      expect(trade.fillPrice).toBeGreaterThan(0);
    }
  });

  it('rejects invalid candle payloads', async () => {
    const request = buildRequest();
    expect(() => eventEngineRequestSchema.parse({
      ...request,
      candles: request.candles.map((c) => ({ ...c, close: -1 })),
    })).toThrow();
  });

  it('index mode trades on index-level prices while stock mode cannot', async () => {
    const base = buildRequest();
    const candles = makeIndexLikeCandles();

    // 指数点位下，股票 100 股整手恒被拒（历史 bug 复现：假设评估 0 交易）
    const stockRequest: EventEngineRequest = {
      ...base, candles,
      config: { ...base.config, tradingUnitMode: 'stock', minimumTradeAmount: 100 },
    };
    const stockResult = await runEventEngine({
      request: stockRequest, enabled: true,
      pythonExecutable: 'python', workerPath: resolve('../tools/backtrader/event_engine_worker.py'),
    });
    expect(stockResult.trades.length).toBe(0);

    // 指数模式：金额单位 + 小数份额，应当产生交易
    const indexRequest: EventEngineRequest = {
      ...base, candles,
      config: { ...base.config, tradingUnitMode: 'index', minimumTradeAmount: 1 },
    };
    const indexResult = await runEventEngine({
      request: indexRequest, enabled: true,
      pythonExecutable: 'python', workerPath: resolve('../tools/backtrader/event_engine_worker.py'),
    });
    expect(indexResult.trades.length).toBeGreaterThan(0);
    expect(indexResult.finalEquity).toBeGreaterThan(0);
    expect(indexResult.trades.some((trade) => trade.quantity % 100 !== 0)).toBe(true);
  });
});
