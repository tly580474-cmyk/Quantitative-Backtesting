import 'dotenv/config';
import { loadConfig } from '../config.js';
import { closePool, createPool } from '../db/connection.js';
import { getResearchSnapshotFreshness } from './snapshotFreshness.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config);
  try {
    const report = await getResearchSnapshotFreshness(pool, config.RESEARCH_SNAPSHOT_ROOT);
    console.log(JSON.stringify(report, null, 2));
    if (report.status !== 'current') process.exitCode = 1;
  } finally {
    await closePool(pool);
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
