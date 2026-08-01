import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
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

export function assertMultiAssetArtifactPath(artifactRoot: string, storageUri: string): string {
  const root = resolve(artifactRoot);
  const target = resolve(storageUri);
  const rel = relative(root, target);
  if (rel === '' || rel.startsWith('..') || rel.includes(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
    throw new Error('ARTIFACT_PATH_OUTSIDE_ROOT');
  }
  return target;
}

export async function verifyMultiAssetArtifact(input: {
  artifactRoot: string;
  storageUri: string;
  byteSize: number;
  contentHash: string;
}): Promise<string> {
  const target = assertMultiAssetArtifactPath(input.artifactRoot, input.storageUri);
  const info = await stat(target);
  if (!info.isFile()) throw new Error('ARTIFACT_NOT_A_FILE');
  if (info.size !== input.byteSize) throw new Error('ARTIFACT_SIZE_MISMATCH');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(target)) hash.update(chunk as Buffer);
  if (hash.digest('hex') !== input.contentHash) throw new Error('ARTIFACT_HASH_MISMATCH');
  return target;
}
