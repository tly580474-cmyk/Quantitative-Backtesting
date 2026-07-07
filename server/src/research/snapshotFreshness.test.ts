import { describe, expect, it } from 'vitest';
import type { ResearchSnapshotManifest } from './snapshotManifest.js';
import { compareSnapshotFreshness } from './snapshotFreshness.js';

const baseManifest: ResearchSnapshotManifest = {
  schemaVersion: 1,
  snapshotId: 'snapshot-1',
  sourceVersion: 'batch-1',
  sourcePublishedAt: '2026-07-07T00:00:00.000Z',
  createdAt: '2026-07-07T00:00:00.000Z',
  status: 'validated',
  rowCount: 100,
  instrumentCount: 10,
  minDate: '2026-01-01',
  maxDate: '2026-07-07',
  partitions: [],
};

describe('snapshot freshness', () => {
  it('accepts a snapshot that matches MySQL row count and max date', () => {
    const report = compareSnapshotFreshness(baseManifest, {
      rowCount: 100,
      maxDate: '2026-07-07',
    });

    expect(report.status).toBe('current');
  });

  it('marks the snapshot stale when MySQL has a newer date', () => {
    const report = compareSnapshotFreshness(baseManifest, {
      rowCount: 110,
      maxDate: '2026-07-08',
    });

    expect(report.status).toBe('stale');
    expect(report.message).toContain('snapshot:build');
  });

  it('marks same-date row count drift as stale', () => {
    const report = compareSnapshotFreshness(baseManifest, {
      rowCount: 101,
      maxDate: '2026-07-07',
    });

    expect(report.status).toBe('stale');
  });

  it('marks a snapshot ahead of MySQL as inconsistent', () => {
    const report = compareSnapshotFreshness(baseManifest, {
      rowCount: 90,
      maxDate: '2026-07-06',
    });

    expect(report.status).toBe('inconsistent');
  });

  it('marks a missing snapshot as unavailable', () => {
    const report = compareSnapshotFreshness(null, {
      rowCount: 100,
      maxDate: '2026-07-07',
    });

    expect(report.status).toBe('unavailable');
  });
});
