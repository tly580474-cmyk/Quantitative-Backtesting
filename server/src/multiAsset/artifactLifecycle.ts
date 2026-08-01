import { rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { assertMultiAssetArtifactPath } from './artifactStore.js';
import {
  deleteMultiAssetRunArtifact,
  listExpiredMultiAssetRunArtifacts,
  type StoredMultiAssetRunArtifact,
} from './repository.js';

export interface MultiAssetArtifactPruneReport {
  dryRun: boolean;
  cutoff: string;
  candidates: number;
  removed: number;
  bytes: number;
  errors: Array<{ artifactId: string; message: string }>;
}

export async function pruneMultiAssetArtifacts(input: {
  artifactRoot: string;
  retentionDays: number;
  dryRun?: boolean;
  limit?: number;
  list?: (cutoff: string, limit: number) => Promise<StoredMultiAssetRunArtifact[]>;
  removeManifest?: (id: string) => Promise<void>;
}): Promise<MultiAssetArtifactPruneReport> {
  if (!Number.isInteger(input.retentionDays) || input.retentionDays < 1) {
    throw new Error('MULTI_ASSET_ARTIFACT_RETENTION_INVALID');
  }
  const dryRun = input.dryRun !== false;
  const cutoff = new Date(Date.now() - input.retentionDays * 86_400_000).toISOString();
  const list = input.list ?? listExpiredMultiAssetRunArtifacts;
  const removeManifest = input.removeManifest ?? deleteMultiAssetRunArtifact;
  const artifacts = await list(cutoff, input.limit ?? 500);
  const report: MultiAssetArtifactPruneReport = {
    dryRun, cutoff, candidates: artifacts.length, removed: 0, bytes: 0, errors: [],
  };
  for (const artifact of artifacts) {
    try {
      const target = assertMultiAssetArtifactPath(input.artifactRoot, artifact.storageUri);
      if (!dryRun) {
        await rm(target, { force: true });
        await removeManifest(artifact.id);
        await rm(dirname(target), { recursive: false }).catch(() => undefined);
      }
      if (!dryRun) report.removed += 1;
      report.bytes += artifact.byteSize;
    } catch (error) {
      report.errors.push({
        artifactId: artifact.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return report;
}
