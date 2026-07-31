import { describe, expect, it } from 'vitest';
import { hashBacktestResult } from '../api';
import type { BacktestResult } from '@/models';

describe('experiment result hashing', () => {
  it('is deterministic for an authoritative result', async () => {
    const result = {
      id: crypto.randomUUID(),
      name: 'M2',
      status: 'completed',
      datasetSnapshot: {
        id: 'd1', symbol: '000985', startTime: '2025-01-01',
        endTime: '2025-01-02', checksum: 'abc',
      },
      strategyId: 's1',
      strategyVersion: '1',
      strategyParams: {},
      config: {},
      startedAt: '2026-07-31T00:00:00.000Z',
      completedAt: '2026-07-31T00:00:01.000Z',
      metrics: {},
      signals: [],
      trades: [],
      equityCurve: [],
    } as unknown as BacktestResult;
    expect(await hashBacktestResult(result)).toMatch(/^[a-f0-9]{64}$/);
    expect(await hashBacktestResult(result)).toBe(await hashBacktestResult(result));
  });
});
