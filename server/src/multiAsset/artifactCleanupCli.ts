import 'dotenv/config';
import { loadConfig } from '../config.js';
import { closePool, createPool } from '../db/connection.js';
import { withMysqlDistributedLock } from '../db/distributedLock.js';
import { closeDb, initDb } from '../db/index.js';
import { defaultMultiAssetArtifactRoot } from './artifactStore.js';
import { pruneMultiAssetArtifacts } from './artifactLifecycle.js';

const config = loadConfig();
const apply = process.argv.includes('--apply');
const pool = createPool(config);
initDb(pool);
try {
  const report = await withMysqlDistributedLock(pool, 'multi-asset:artifact-prune', 0, () =>
    pruneMultiAssetArtifacts({
      artifactRoot: defaultMultiAssetArtifactRoot(config.RESEARCH_SNAPSHOT_ROOT),
      retentionDays: Number(config.MULTI_ASSET_ARTIFACT_RETENTION_DAYS),
      dryRun: !apply,
    }));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await closeDb();
  await closePool(pool);
}
