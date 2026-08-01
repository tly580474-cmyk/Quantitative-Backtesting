import 'dotenv/config';
import { loadConfig } from '../config.js';
import { closePool, createPool } from '../db/connection.js';
import { closeDb, initDb } from '../db/index.js';
import { collectMultiAssetOperationalStatus } from './operations.js';

const config = loadConfig();
const pool = createPool(config);
initDb(pool);
try {
  const status = await collectMultiAssetOperationalStatus({
    workerStaleMs: Number(config.MULTI_ASSET_WORKER_STALE_MS),
    queueWarningSeconds: Number(config.MULTI_ASSET_QUEUE_WARNING_SECONDS),
    queueCriticalSeconds: Number(config.MULTI_ASSET_QUEUE_CRITICAL_SECONDS),
  });
  console.log(JSON.stringify(status, null, 2));
  if (status.level === 'critical') process.exitCode = 2;
  else if (status.level === 'warning') process.exitCode = 1;
} finally {
  await closeDb();
  await closePool(pool);
}
