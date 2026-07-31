import { describe, expect, it } from 'vitest';
import { canonicalHash, createExperimentRunRequestSchema } from './schema.js';

describe('M2 experiment contracts', () => {
  it('hashes equivalent object key orders identically', () => {
    const hash = canonicalHash({ b: 2, a: { y: 2, x: 1 } });
    expect(hash).toBe(canonicalHash({ a: { x: 1, y: 2 }, b: 2 }));
    expect(hash).toBe('a357b74a066b211d9bc4f054cd6a83d05194afe0804ca9c438f8d06be617fd19');
  });

  it('rejects same-close execution and non-strategy runs', () => {
    const base = {
      experimentVersionId: crypto.randomUUID(),
      idempotencyKey: 'm2-run-0001',
      engineVersion: '1.0.0',
      datasetSnapshot: {
        id: 'dataset',
        symbol: '000985',
        startTime: '2020-01-01',
        endTime: '2026-07-30',
        checksum: 'checksum',
      },
      config: {
        backtestMode: 'strategy',
        initialCapital: 100_000,
        tradingDays: 0,
        positionSizing: { type: 'percent', value: 1 },
        commissionRate: 0.0003,
        minimumCommission: 5,
        sellTaxRate: 0.001,
        slippageBps: 1,
        tradingUnitMode: 'stock',
        minimumTradeAmount: 1,
        dca: { amount: 1000, frequency: 'monthly' },
        execution: 'next_open',
        forceCloseAtEnd: true,
      },
      strategyParams: {},
    };
    expect(createExperimentRunRequestSchema.safeParse(base).success).toBe(true);
    expect(createExperimentRunRequestSchema.safeParse({
      ...base,
      config: { ...base.config, execution: 'same_close' },
    }).success).toBe(false);
  });
});
