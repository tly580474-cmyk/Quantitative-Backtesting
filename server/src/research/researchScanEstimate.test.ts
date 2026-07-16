import { describe, expect, it } from 'vitest';
import { estimateSnapshotScan } from './researchScanEstimate.js';
import type { ResearchSnapshotManifest } from './snapshotManifest.js';

const manifest: ResearchSnapshotManifest = {
  schemaVersion: 1,
  snapshotId: 's1',
  sourceVersion: 'v1',
  sourcePublishedAt: null,
  createdAt: '2026-01-01T00:00:00Z',
  status: 'validated',
  rowCount: 100,
  instrumentCount: 2,
  minDate: '2025-01-01',
  maxDate: '2025-12-31',
  partitions: [
    { year: 2025, relativePath: 'bars/year=2025/a.parquet', rows: 100, bytes: 1000, minDate: '2025-01-01', maxDate: '2025-12-31', sha256: 'x' },
  ],
  datasets: [
    { name: 'dividend_events', relativePath: 'reference/dividend.parquet', rows: 5, bytes: 50, minDate: null, maxDate: null, sha256: 'y', sourceVersion: null },
  ],
};

describe('research scan estimate', () => {
  it('uses manifest rows and bytes for referenced views', () => {
    expect(estimateSnapshotScan('SELECT * FROM bars JOIN dividend_events USING (instrumentKey)', manifest))
      .toMatchObject({ files: 2, rows: 105, bytes: 1050 });
  });
});
