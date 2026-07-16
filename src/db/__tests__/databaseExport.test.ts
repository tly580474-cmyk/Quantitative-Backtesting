import { describe, expect, it } from 'vitest';
import {
  buildMigrationManifest,
  flattenLeaves,
  flattenRecord,
} from '../databaseExport';

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

  it('builds a deterministic migration audit manifest', () => {
    const tables = [{
      name: '数据集',
      rows: [
        { id: 'd2', startTime: '2024-02-01', count: 2 },
        { id: 'd1', startTime: '2024-01-01', count: 1 },
      ],
    }];
    const first = buildMigrationManifest(tables, 'indexeddb', '2026-07-16T00:00:00.000Z');
    const second = buildMigrationManifest(tables, 'indexeddb', '2026-07-16T00:00:00.000Z');

    expect(first).toEqual(second);
    expect(first[0]).toMatchObject({
      source: 'indexeddb-readonly-migration',
      table: '数据集',
      rowCount: 2,
      minDate: '2024-01-01T00:00:00.000Z',
      maxDate: '2024-02-01T00:00:00.000Z',
      recordIdCount: 2,
      recordIdSample: 'd1,d2',
      checksumAlgorithm: 'fnv1a64-canonical-row-v1',
    });
    expect(first[0].checksum).toMatch(/^[0-9a-f]{16}$/);
  });
});
