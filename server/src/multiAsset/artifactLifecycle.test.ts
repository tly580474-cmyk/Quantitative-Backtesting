import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pruneMultiAssetArtifacts } from './artifactLifecycle.js';
import type { StoredMultiAssetRunArtifact } from './repository.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ root: string; target: string; artifact: StoredMultiAssetRunArtifact }> {
  const root = await mkdtemp(join(tmpdir(), 'multi-asset-prune-'));
  roots.push(root);
  const target = join(root, 'run-1.json');
  await writeFile(target, 'test');
  return {
    root,
    target,
    artifact: {
      id: 'artifact-1', runId: 'run-1', kind: 'execution_result', contentHash: 'hash',
      storageUri: target, byteSize: 4, mediaType: 'application/json', createdAt: new Date(0).toISOString(),
    },
  };
}

describe('multi-asset artifact lifecycle', () => {
  it('is dry-run by default and leaves files and manifests untouched', async () => {
    const { root, target, artifact } = await fixture();
    const removeManifest = vi.fn();
    const report = await pruneMultiAssetArtifacts({
      artifactRoot: root,
      retentionDays: 30,
      list: async () => [artifact],
      removeManifest,
    });
    expect(report).toMatchObject({ dryRun: true, candidates: 1, removed: 0, bytes: 4 });
    await expect(stat(target)).resolves.toBeDefined();
    expect(removeManifest).not.toHaveBeenCalled();
  });

  it('deletes the file before its manifest when apply is explicit', async () => {
    const { root, target, artifact } = await fixture();
    const removeManifest = vi.fn(async () => undefined);
    const report = await pruneMultiAssetArtifacts({
      artifactRoot: root,
      retentionDays: 30,
      dryRun: false,
      list: async () => [artifact],
      removeManifest,
    });
    expect(report).toMatchObject({ dryRun: false, candidates: 1, removed: 1, errors: [] });
    await expect(stat(target)).rejects.toThrow();
    expect(removeManifest).toHaveBeenCalledWith('artifact-1');
  });
});
