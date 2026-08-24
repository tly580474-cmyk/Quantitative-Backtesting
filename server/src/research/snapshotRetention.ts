import { readFile, readdir, rm, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import {
  readCurrentSnapshot,
  validateManifest,
  type ResearchSnapshotManifest,
} from './snapshotManifest.js';

export interface SnapshotRetentionOptions {
  root: string;
  retentionDays: number;
  dryRun: boolean;
  now?: Date;
}

export interface SnapshotRetentionEntry {
  snapshotId: string;
  createdAt?: string;
  logicalBytes?: number;
  reason: string;
}

export interface SnapshotRetentionReport {
  status: 'dry-run' | 'applied';
  currentSnapshotId: string;
  policy: {
    retentionDays: number;
  };
  kept: SnapshotRetentionEntry[];
  removed: SnapshotRetentionEntry[];
  skipped: SnapshotRetentionEntry[];
  removableLogicalBytes: number;
}

interface ValidSnapshot {
  snapshotId: string;
  path: string;
  manifest: ResearchSnapshotManifest;
  createdMs: number;
  logicalBytes: number;
}

export async function pruneResearchSnapshots(
  options: SnapshotRetentionOptions,
): Promise<SnapshotRetentionReport> {
  const root = resolve(options.root);
  const retentionDays = requirePositiveInteger(options.retentionDays, 'retentionDays');
  const now = options.now ?? new Date();
  const current = await readCurrentSnapshot(root);
  if (!current) throw new Error('尚未发布可用的研究快照，拒绝执行清理');

  const entries = await readdir(root, { withFileTypes: true });
  const valid: ValidSnapshot[] = [];
  const skipped: SnapshotRetentionEntry[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.building-')) {
      skipped.push({ snapshotId: entry.name, reason: 'building-directory' });
      continue;
    }
    const snapshotPath = join(root, entry.name);
    try {
      const manifest = JSON.parse(
        await readFile(join(snapshotPath, 'manifest.json'), 'utf8'),
      ) as ResearchSnapshotManifest;
      if (manifest.snapshotId !== entry.name) {
        throw new Error('目录名与 manifest.snapshotId 不一致');
      }
      validateManifest({
        snapshotId: manifest.snapshotId,
        publishedAt: manifest.createdAt,
      }, manifest);
      const createdMs = Date.parse(manifest.createdAt);
      if (!Number.isFinite(createdMs)) throw new Error('manifest.createdAt 无效');
      valid.push({
        snapshotId: entry.name,
        path: snapshotPath,
        manifest,
        createdMs,
        logicalBytes: await manifestLogicalBytes(snapshotPath, manifest),
      });
    } catch (error) {
      skipped.push({
        snapshotId: entry.name,
        reason: `invalid-or-unknown: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  valid.sort((a, b) => b.createdMs - a.createdMs);
  const keepReasons = new Map<string, string>();
  keepReasons.set(current.manifest.snapshotId, 'current');

  const cutoffMs = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
  for (const snapshot of valid) {
    if (snapshot.createdMs < cutoffMs) continue;
    addKeepReason(keepReasons, snapshot.snapshotId, 'within-retention-window');
  }

  const kept: SnapshotRetentionEntry[] = [];
  const removed: SnapshotRetentionEntry[] = [];
  for (const snapshot of valid) {
    const keepReason = keepReasons.get(snapshot.snapshotId);
    if (keepReason) {
      kept.push(toReportEntry(snapshot, keepReason));
      continue;
    }
    assertDirectChild(root, snapshot.path);
    if (snapshot.snapshotId === current.manifest.snapshotId) {
      throw new Error('内部保护检查失败：当前快照进入了删除集合');
    }
    removed.push(toReportEntry(snapshot, options.dryRun ? 'would-remove' : 'removed'));
    if (!options.dryRun) {
      await rm(snapshot.path, { recursive: true, force: false });
    }
  }

  return {
    status: options.dryRun ? 'dry-run' : 'applied',
    currentSnapshotId: current.manifest.snapshotId,
    policy: { retentionDays },
    kept,
    removed,
    skipped,
    removableLogicalBytes: removed.reduce((sum, item) => sum + (item.logicalBytes ?? 0), 0),
  };
}

function addKeepReason(reasons: Map<string, string>, snapshotId: string, reason: string): void {
  const existing = reasons.get(snapshotId);
  reasons.set(snapshotId, existing ? `${existing},${reason}` : reason);
}

function toReportEntry(snapshot: ValidSnapshot, reason: string): SnapshotRetentionEntry {
  return {
    snapshotId: snapshot.snapshotId,
    createdAt: snapshot.manifest.createdAt,
    logicalBytes: snapshot.logicalBytes,
    reason,
  };
}

async function manifestLogicalBytes(
  snapshotPath: string,
  manifest: ResearchSnapshotManifest,
): Promise<number> {
  const payload = [
    ...manifest.partitions.map((item) => item.bytes),
    ...(manifest.datasets ?? []).map((item) => item.bytes),
  ].reduce((sum, bytes) => sum + bytes, 0);
  const manifestStat = await stat(join(snapshotPath, 'manifest.json'));
  return payload + manifestStat.size;
}

function requirePositiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} 必须是正整数`);
  }
  return value;
}

function assertDirectChild(root: string, target: string): void {
  const relativePath = relative(root, resolve(target));
  if (!relativePath || relativePath.startsWith('..') || relativePath.includes(sep)) {
    throw new Error(`拒绝删除快照根目录之外或非直属目录：${target}`);
  }
}
