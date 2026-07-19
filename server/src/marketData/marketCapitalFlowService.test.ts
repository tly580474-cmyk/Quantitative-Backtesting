import { describe, expect, it } from 'vitest';
import { aggregateMarketCapitalFlow } from './marketCapitalFlowService.js';

describe('market capital flow aggregation', () => {
  it('deduplicates stocks and excludes missing values from coverage', () => {
    const result = aggregateMarketCapitalFlow([
      { f12: '600001', f62: 300_000_000 },
      { f12: '600001', f62: 999_000_000 },
      { f12: '000001', f62: -100_000_000 },
      { f12: '000002', f62: null },
    ], 3);

    expect(result.mainNetInYi).toBe(2);
    expect(result.sampleCount).toBe(2);
    expect(result.coveragePct).toBe(66.67);
  });
});
