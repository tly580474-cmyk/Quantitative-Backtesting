import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pruneResearchSnapshots } from './snapshotRetention.js';
import type { ResearchSnapshotManifest } from './snapshotManifest.js';

const roots: string[] = [];
afterEach(async () => Promise.all(
  roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
));

describe('snapshot retention', () => {
  it('keeps current/latest/daily/pinned snapshots and removes only eligible versions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'snapshot-retention-'));
    roots.push(root);
    await createSnapshot(root, 'current', '2026-07-10T12:00:00.000Z');
    await createSnapshot(root, 'same-day-old', '2026-07-10T10:00:00.000Z');
    await createSnapshot(root, 'daily', '2026-07-09T12:00:00.000Z');
    await createSnapshot(root, 'expired', '2026-06-01T12:00:00.000Z');
    await createSnapshot(root, 'pinned', '2026-05-01T12:00:00.000Z', true);
    await mkdir(join(root, '.building-interrupted'));
    await writeFile(join(root, 'current.json'), JSON.stringify({
      snapshotId: 'current',
      publishedAt: '2026-07-10T12:00:01.000Z',
    }));

    const report = await pruneResearchSnapshots({
      root,
      retainLatest: 1,
      retainDailyDays: 7,
      dryRun: false,
      now: new Date('2026-07-10T18:00:00.000Z'),
    });

    expect(report.removed.map((item) => item.snapshotId).sort())
      .toEqual(['expired', 'same-day-old']);
    expect(report.kept.find((item) => item.snapshotId === 'current')?.reason).toContain('current');
    expect(report.kept.find((item) => item.snapshotId === 'daily')?.reason).toContain('daily');
    expect(report.kept.find((item) => item.snapshotId === 'pinned')?.reason).toContain('pinned');
    expect(report.skipped).toContainEqual(expect.objectContaining({
      snapshotId: '.building-interrupted',
      reason: 'building-directory',
    }));
    await expect(stat(join(root, 'current'))).resolves.toBeDefined();
    await expect(stat(join(root, 'expired'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('defaults to reporting candidates without deleting them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'snapshot-retention-dry-'));
    roots.push(root);
    await createSnapshot(root, 'current', '2026-07-10T12:00:00.000Z');
    await createSnapshot(root, 'old', '2026-05-01T12:00:00.000Z');
    await writeFile(join(root, 'current.json'), JSON.stringify({
      snapshotId: 'current',
      publishedAt: '2026-07-10T12:00:01.000Z',
    }));

    const report = await pruneResearchSnapshots({
      root,
      retainLatest: 1,
      retainDailyDays: 7,
      dryRun: true,
      now: new Date('2026-07-10T18:00:00.000Z'),
    });

    expect(report.status).toBe('dry-run');
    expect(report.removed).toContainEqual(expect.objectContaining({
      snapshotId: 'old',
      reason: 'would-remove',
    }));
    await expect(stat(join(root, 'old'))).resolves.toBeDefined();
  });
});

async function createSnapshot(
  root: string,
  snapshotId: string,
  createdAt: string,
  pinned = false,
): Promise<void> {
  const path = join(root, snapshotId);
  await mkdir(path);
  const manifest: ResearchSnapshotManifest = {
    schemaVersion: 1,
    snapshotId,
    sourceVersion: 'test',
    sourcePublishedAt: null,
    createdAt,
    status: 'validated',
    rowCount: 0,
    instrumentCount: 0,
    minDate: '2026-01-01',
    maxDate: '2026-01-01',
    partitions: [],
    datasets: [],
  };
  await writeFile(join(path, 'manifest.json'), JSON.stringify(manifest));
  if (pinned) await writeFile(join(path, '.retain'), '');
}
