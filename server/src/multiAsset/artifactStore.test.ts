import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { assertMultiAssetArtifactPath, verifyMultiAssetArtifact } from './artifactStore.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('multi-asset artifact integrity', () => {
  it('accepts an artifact inside the root with matching size and sha256', async () => {
    const root = await mkdtemp(join(tmpdir(), 'multi-asset-artifact-'));
    roots.push(root);
    const target = join(root, 'run-1.json');
    const bytes = Buffer.from('{"ok":true}');
    await writeFile(target, bytes);
    await expect(verifyMultiAssetArtifact({
      artifactRoot: root,
      storageUri: target,
      byteSize: bytes.byteLength,
      contentHash: createHash('sha256').update(bytes).digest('hex'),
    })).resolves.toBe(target);
  });

  it('rejects traversal and tampered content', async () => {
    const root = await mkdtemp(join(tmpdir(), 'multi-asset-artifact-'));
    roots.push(root);
    expect(() => assertMultiAssetArtifactPath(root, join(root, '..', 'escape.json')))
      .toThrow('ARTIFACT_PATH_OUTSIDE_ROOT');
    const target = join(root, 'run-1.json');
    await writeFile(target, 'tampered');
    await expect(verifyMultiAssetArtifact({
      artifactRoot: root,
      storageUri: target,
      byteSize: 8,
      contentHash: '0'.repeat(64),
    })).rejects.toThrow('ARTIFACT_HASH_MISMATCH');
  });
});
