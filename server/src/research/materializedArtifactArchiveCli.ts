import 'dotenv/config';
import { loadConfig } from '../config.js';
import { archiveStaleMaterializations } from './materializedArtifactHealth.js';
import { readCurrentSnapshot } from './snapshotManifest.js';

const config = loadConfig();
const current = await readCurrentSnapshot(config.RESEARCH_SNAPSHOT_ROOT);
const actions = await archiveStaleMaterializations({
  artifactRoot: config.FACTOR_RESEARCH_ROOT,
  currentSnapshotId: current?.manifest.snapshotId ?? null,
  dryRun: process.argv.includes('--dry-run'),
});
console.log(JSON.stringify({
  currentSnapshotId: current?.manifest.snapshotId ?? null,
  actions,
}, null, 2));
