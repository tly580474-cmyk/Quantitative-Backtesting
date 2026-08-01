import { createHash } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { storeMultiAssetRunArtifact } from './repository.js';

export async function persistMultiAssetJsonArtifact(input: {
  artifactRoot: string;
  runId: string;
  kind: 'rebalance_plan' | 'execution_result';
  value: unknown;
}) {
  const root = resolve(input.artifactRoot);
  const target = resolve(root, input.runId, `${input.kind}.json`);
  if (!target.startsWith(`${root}\\`) && !target.startsWith(`${root}/`)) throw new Error('ARTIFACT_PATH_OUTSIDE_ROOT');
  const bytes = Buffer.from(JSON.stringify(input.value));
  const contentHash = createHash('sha256').update(bytes).digest('hex');
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, bytes, { flag: 'wx' });
  await rename(temporary, target);
  return storeMultiAssetRunArtifact({
    runId: input.runId,
    kind: input.kind,
    contentHash,
    storageUri: target,
    byteSize: bytes.byteLength,
    mediaType: 'application/json',
  });
}

export function defaultMultiAssetArtifactRoot(snapshotRoot: string): string {
  return join(resolve(snapshotRoot), '..', 'multi-asset-artifacts');
}
