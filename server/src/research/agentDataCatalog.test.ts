import { describe, expect, it } from 'vitest';
import { buildDataRoutingPrompt, catalogDataset, datasetCoverage } from './agentDataCatalog.js';
import type { ResearchSnapshotManifest } from './snapshotManifest.js';
const manifest = { snapshotId: 's1', minDate: '2000-01-04', maxDate: '2026-09-04', rowCount: 100,
  datasets: [{ name: 'financial_reports', rows: 5, minDate: '2020-03-31', maxDate: '2026-06-30' }],
} as ResearchSnapshotManifest;
describe('agent data routing', () => {
  it('keeps reference coverage independent of bars and treats absent data as unknown', () => {
    expect(datasetCoverage('financials', manifest)).toMatchObject({ minDate: '2020-03-31', maxDate: '2026-06-30', rangeStatus: 'unknown' });
    expect(datasetCoverage('dividends', manifest)).toMatchObject({ available: false, maxDate: null });
    expect(datasetCoverage('valuations', manifest)).toMatchObject({ available: true, rows: 100 });
    expect(datasetCoverage('daily_bars', manifest, '1999-01-01')).toMatchObject({ rangeStatus: 'outside' });
    expect(datasetCoverage('daily_bars', null)).toMatchObject({ available: false, rangeStatus: 'unknown' });
  });
  it('rejects arbitrary view names and exposes batch routing', () => {
    expect(() => catalogDataset('bars; DROP TABLE bars')).toThrow('INVALID_ARGUMENT');
    expect(buildDataRoutingPrompt()).toContain('不要逐股调用行情 API');
  });
});
