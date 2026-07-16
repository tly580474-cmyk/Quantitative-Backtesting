import 'dotenv/config';
import { loadConfig } from '../config.js';
import { closePool, createPool } from '../db/connection.js';
import { reconcileDatabase } from './dataReconciliation.js';

async function main(): Promise<void> {
  const pool = createPool(loadConfig());
  try {
    const report = await reconcileDatabase(pool);
    console.log(JSON.stringify(report, null, 2));
    if (report.status === 'fail') process.exitCode = 1;
  } finally {
    await closePool(pool);
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
