import 'dotenv/config';
import { loadConfig } from '../config.js';
import { closePool, createPool } from '../db/connection.js';
import { initDb } from '../db/index.js';
import { cleanupExpiredReportArtifacts } from './m3Repository.js';

async function main(): Promise<void> {
  const pool = createPool(loadConfig());
  initDb(pool);
  try {
    const removed = await cleanupExpiredReportArtifacts();
    console.log(JSON.stringify({ removed, retentionDays: 7 }, null, 2));
  } finally {
    await closePool(pool);
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
