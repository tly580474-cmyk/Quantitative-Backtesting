import 'dotenv/config';
import { loadConfig } from '../config.js';
import { closePool, createPool } from '../db/connection.js';
import { getDataHealthGate } from './dataHealthGate.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config);
  try {
    const report = await getDataHealthGate(
      pool,
      config.RESEARCH_SNAPSHOT_ROOT,
      config.MINUTE_DATA_ROOT,
    );
    console.log(JSON.stringify(report, null, 2));
    if (report.status !== 'pass') process.exitCode = 1;
  } finally {
    await closePool(pool);
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
