import { mkdir, readFile, readdir, rename, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export interface MaterializedArtifactHealth {
  root: string;
  currentSnapshotId: string | null;
  total: number;
  current: number;
  stale: number;
  invalid: number;
  staleBytes: number;
  staleSnapshots: string[];
}

export async function inspectMaterializedArtifacts(
  artifactRootInput: string,
  currentSnapshotId: string | null,
): Promise<MaterializedArtifactHealth> {
  const root = resolve(artifactRootInput, 'factor-values');
  const result: MaterializedArtifactHealth = {
    root,
    currentSnapshotId,
    total: 0,
    current: 0,
    stale: 0,
    invalid: 0,
    staleBytes: 0,
    staleSnapshots: [],
  };
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return result;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('snapshot=')) continue;
    const snapshotId = entry.name.slice('snapshot='.length);
    const snapshotPath = join(root, entry.name);
    const factorDirs = (await readdir(snapshotPath, { withFileTypes: true }))
      .filter((item) => item.isDirectory() && item.name.startsWith('factor='));
    for (const factor of factorDirs) {
      result.total += 1;
      const factorPath = join(snapshotPath, factor.name);
      let valid = false;
      try {
        const manifest = JSON.parse(
          await readFile(join(factorPath, 'manifest.json'), 'utf8'),
        ) as Record<string, unknown>;
        valid = manifest.status === 'validated' && manifest.snapshotId === snapshotId;
      } catch {
        valid = false;
      }
      if (!valid) {
        result.invalid += 1;
        continue;
      }
      if (currentSnapshotId && snapshotId === currentSnapshotId) {
        result.current += 1;
      } else {
        result.stale += 1;
        result.staleBytes += await directoryBytes(factorPath);
        result.staleSnapshots.push(snapshotId);
      }
    }
  }
  result.staleSnapshots = [...new Set(result.staleSnapshots)].sort();
  return result;
}

export async function archiveStaleMaterializations(options: {
  artifactRoot: string;
  currentSnapshotId: string | null;
  dryRun: boolean;
  now?: Date;
}): Promise<Array<{ source: string; target: string; dryRun: boolean }>> {
  const activeRoot = resolve(options.artifactRoot, 'factor-values');
  const archiveRoot = resolve(options.artifactRoot, 'factor-values-archive');
  const health = await inspectMaterializedArtifacts(options.artifactRoot, options.currentSnapshotId);
  const stamp = (options.now ?? new Date()).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const actions = health.staleSnapshots.map((snapshotId) => ({
    source: resolve(activeRoot, `snapshot=${snapshotId}`),
    target: resolve(archiveRoot, `snapshot=${snapshotId}-${stamp}`),
    dryRun: options.dryRun,
  }));
  if (!options.dryRun && actions.length > 0) {
    await mkdir(archiveRoot, { recursive: true });
    for (const action of actions) await rename(action.source, action.target);
  }
  return actions;
}

async function directoryBytes(root: string): Promise<number> {
  let bytes = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) bytes += await directoryBytes(path);
    else if (entry.isFile()) bytes += (await stat(path)).size;
  }
  return bytes;
}
