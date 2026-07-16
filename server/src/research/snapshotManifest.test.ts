import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { validateManifest, type ResearchSnapshotManifest } from './snapshotManifest.js';

const manifest: ResearchSnapshotManifest = {
  schemaVersion: 1,
  snapshotId: 'snapshot-1',
  sourceVersion: 'batch-1',
  sourcePublishedAt: '2026-07-04T00:00:00.000Z',
  createdAt: '2026-07-05T00:00:00.000Z',
  status: 'validated',
  rowCount: 3,
  instrumentCount: 2,
  minDate: '2025-01-01',
  maxDate: '2026-01-01',
  partitions: [
    {
      year: 2025,
      relativePath: 'bars/year=2025/data.parquet',
      rows: 2,
      bytes: 100,
      minDate: '2025-01-01',
      maxDate: '2025-12-31',
      sha256: 'a',
    },
    {
      year: 2026,
      relativePath: 'bars/year=2026/data.parquet',
      rows: 1,
      bytes: 80,
      minDate: '2026-01-01',
      maxDate: '2026-01-01',
      sha256: 'b',
    },
  ],
  datasets: [{
    name: 'adjustment_factors',
    relativePath: 'adjustment_factors/data.parquet',
    rows: 4,
    bytes: 50,
    minDate: '2025-01-01',
    maxDate: '2026-01-01',
    sha256: 'c',
    sourceVersion: '2026-07-05T00:00:00.000Z',
  }],
};

describe('snapshot manifest', () => {
  it('accepts a matching validated snapshot', () => {
    assert.doesNotThrow(() => validateManifest({
      snapshotId: 'snapshot-1',
      publishedAt: '2026-07-05T00:00:00.000Z',
    }, manifest));
  });

  it('rejects row-count drift', () => {
    assert.throws(() => validateManifest({
      snapshotId: 'snapshot-1',
      publishedAt: '2026-07-05T00:00:00.000Z',
    }, { ...manifest, rowCount: 4 }), /行数不一致/);
  });

  it('rejects duplicate reference dataset names', () => {
    assert.throws(() => validateManifest({
      snapshotId: 'snapshot-1',
      publishedAt: '2026-07-05T00:00:00.000Z',
    }, { ...manifest, datasets: [manifest.datasets![0], manifest.datasets![0]] }), /名称重复/);
  });
});
