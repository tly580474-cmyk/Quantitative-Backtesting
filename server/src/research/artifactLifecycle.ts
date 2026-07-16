import { readdir, rm, stat } from 'node:fs/promises';
import { isAbsolute, join, parse, relative, resolve } from 'node:path';

export interface ArtifactLifecycleReport {
  root: string;
  dryRun: boolean;
  partialMaxAgeHours: number;
  removed: Array<{ path: string; bytes: number; reason: string }>;
  reclaimedBytes: number;
}

export async function pruneResearchArtifacts(options: {
  root: string;
  partialMaxAgeHours: number;
  dryRun: boolean;
  now?: Date;
}): Promise<ArtifactLifecycleReport> {
  const root = resolve(options.root);
  if (root === parse(root).root) throw new Error('拒绝对文件系统根目录执行产物清理');
  const now = options.now ?? new Date();
  const cutoff = now.getTime() - options.partialMaxAgeHours * 3_600_000;
  const removed: ArtifactLifecycleReport['removed'] = [];
  for (const path of await listEntries(root)) {
    const info = await stat(path);
    const name = path.replaceAll('\\', '/');
    if (!name.endsWith('.partial') || info.mtimeMs > cutoff) continue;
    assertWithinRoot(root, path);
    const bytes = info.isDirectory() ? await directoryBytes(path) : info.size;
    removed.push({
      path,
      bytes,
      reason: `partial older than ${options.partialMaxAgeHours}h`,
    });
    if (!options.dryRun) await rm(path, { recursive: info.isDirectory(), force: true });
  }
  return {
    root,
    dryRun: options.dryRun,
    partialMaxAgeHours: options.partialMaxAgeHours,
    removed,
    reclaimedBytes: removed.reduce((sum, item) => sum + item.bytes, 0),
  };
}

async function listEntries(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const result: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    result.push(path);
    if (entry.isDirectory() && !entry.name.endsWith('.partial')) {
      result.push(...await listEntries(path));
    }
  }
  return result;
}

async function directoryBytes(root: string): Promise<number> {
  let bytes = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    bytes += entry.isDirectory() ? await directoryBytes(path) : (await stat(path)).size;
  }
  return bytes;
}

function assertWithinRoot(root: string, path: string): void {
  const child = relative(root, resolve(path));
  if (child.startsWith('..') || isAbsolute(child)) {
    throw new Error(`拒绝清理输出根目录之外的路径：${path}`);
  }
}
