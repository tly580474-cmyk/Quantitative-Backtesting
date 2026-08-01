import { describe, expect, it } from 'vitest';
import { buildRobustnessCases } from '../robustness';

describe('M3 robustness plan', () => {
  it('covers parameter, cost, date and delay perturbations deterministically', () => {
    const cases = buildRobustnessCases({
      candles: Array.from({ length: 20 }, (_, index) => ({ time: String(index), symbol: 'x' })) as never,
      strategy: { id: 's', evaluate: () => ({ time: '', action: 'hold', reason: '' }) } as never,
      strategyParams: { period: 20 },
      config: { commissionRate: 1, minimumCommission: 1, sellTaxRate: 1, slippageBps: 1 } as never,
      baseline: { datasetSnapshot: {} } as never,
    });
    expect(new Set(cases.map((item) => item.id.split(':')[0]))).toEqual(new Set(['parameter', 'cost', 'date', 'delay']));
  });
});
