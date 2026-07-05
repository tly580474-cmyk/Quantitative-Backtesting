import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface ResearchSnapshotPartition {
  year: number;
  relativePath: string;
  rows: number;
  bytes: number;
  minDate: string;
  maxDate: string;
  sha256: string;
}

export interface ResearchSnapshotManifest {
  schemaVersion: 1;
  snapshotId: string;
  sourceVersion: string;
  sourcePublishedAt: string | null;
  createdAt: string;
  status: 'validated';
  rowCount: number;
  instrumentCount: number;
  minDate: string;
  maxDate: string;
  partitions: ResearchSnapshotPartition[];
}

export interface CurrentSnapshotPointer {
  snapshotId: string;
  publishedAt: string;
}

export async function readCurrentSnapshot(
  root: string,
): Promise<{ pointer: CurrentSnapshotPointer; manifest: ResearchSnapshotManifest } | null> {
  try {
    const pointer = JSON.parse(
      await readFile(join(root, 'current.json'), 'utf8'),
    ) as CurrentSnapshotPointer;
    const manifest = JSON.parse(
      await readFile(join(root, pointer.snapshotId, 'manifest.json'), 'utf8'),
    ) as ResearchSnapshotManifest;
    validateManifest(pointer, manifest);
    return { pointer, manifest };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export function validateManifest(
  pointer: CurrentSnapshotPointer,
  manifest: ResearchSnapshotManifest,
): void {
  if (manifest.schemaVersion !== 1 || manifest.status !== 'validated') {
    throw new Error('研究快照 manifest 未通过校验');
  }
  if (pointer.snapshotId !== manifest.snapshotId) {
    throw new Error('研究快照指针与 manifest 不一致');
  }
  const partitionRows = manifest.partitions.reduce((sum, item) => sum + item.rows, 0);
  if (partitionRows !== manifest.rowCount) {
    throw new Error(`研究快照行数不一致：manifest=${manifest.rowCount}, partitions=${partitionRows}`);
  }
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}
