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
      forceCloseAtEnd: true,
    },
  };
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
});
