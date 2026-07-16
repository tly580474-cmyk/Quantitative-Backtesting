import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  archiveStaleMaterializations,
  inspectMaterializedArtifacts,
} from './materializedArtifactHealth.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('materialized artifact health', () => {
  it('separates current, stale and invalid factor materializations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'materialized-health-'));
    roots.push(root);
    for (const [snapshot, factor, valid] of [
      ['current', 'a', true],
      ['old', 'b', true],
      ['old', 'broken', false],
    ] as const) {
      const path = join(root, 'factor-values', `snapshot=${snapshot}`, `factor=${factor}`);
      await mkdir(path, { recursive: true });
      await writeFile(join(path, 'manifest.json'), valid
        ? JSON.stringify({ status: 'validated', snapshotId: snapshot })
        : '{}');
      await writeFile(join(path, 'part.parquet'), 'data');
    }
    const health = await inspectMaterializedArtifacts(root, 'current');
    expect(health).toMatchObject({ total: 3, current: 1, stale: 1, invalid: 1 });
    expect(health.staleBytes).toBeGreaterThan(0);
    expect(health.staleSnapshots).toEqual(['old']);
  });

  it('archives whole stale snapshot directories outside the active path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'materialized-archive-'));
    roots.push(root);
    const path = join(root, 'factor-values', 'snapshot=old', 'factor=a');
    await mkdir(path, { recursive: true });
    await writeFile(join(path, 'manifest.json'), JSON.stringify({ status: 'validated', snapshotId: 'old' }));
    const actions = await archiveStaleMaterializations({
      artifactRoot: root,
      currentSnapshotId: 'current',
      dryRun: false,
      now: new Date('2026-07-16T00:00:00Z'),
    });
    expect(actions).toHaveLength(1);
    expect((await inspectMaterializedArtifacts(root, 'current')).stale).toBe(0);
  });
});
