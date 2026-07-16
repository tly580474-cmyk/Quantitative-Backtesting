import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pruneResearchArtifacts } from './artifactLifecycle.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe('artifact lifecycle', () => {
  it('only removes expired partial outputs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'artifact-life-'));
    roots.push(root);
    await writeFile(join(root, 'keep.csv'), 'ok');
    await mkdir(join(root, 'run.partial'));
    await writeFile(join(root, 'run.partial', 'part'), 'x');
    const now = new Date(Date.now() + 48 * 3_600_000);
    const report = await pruneResearchArtifacts({
      root,
      partialMaxAgeHours: 24,
      dryRun: false,
      now,
    });
    expect(report.removed).toHaveLength(1);
    await expect(stat(join(root, 'keep.csv'))).resolves.toBeDefined();
    await expect(stat(join(root, 'run.partial'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
