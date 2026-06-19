import { describe, expect, it } from 'vitest';
import { flattenLeaves, flattenRecord } from '../databaseExport';

describe('database table export helpers', () => {
  it('expands nested objects into table columns without JSON cells', () => {
    expect(flattenRecord({
      id: 'r1',
      metrics: { totalReturn: 0.12, tradeCount: 3 },
      trades: [{ id: 't1' }],
    })).toEqual({
      id: 'r1',
      'metrics.totalReturn': 0.12,
      'metrics.tradeCount': 3,
    });
  });

  it('expands arrays and objects into long-form field rows', () => {
    expect(flattenLeaves(
      { indicators: [{ id: 'ma1', params: { period: 20 } }] },
      'strategy',
      's1',
    )).toEqual([
      { recordType: 'strategy', recordId: 's1', path: 'indicators.0.id', value: 'ma1' },
      { recordType: 'strategy', recordId: 's1', path: 'indicators.0.params.period', value: 20 },
    ]);
  });
});
