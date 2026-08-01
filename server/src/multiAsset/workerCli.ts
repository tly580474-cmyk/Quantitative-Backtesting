import 'dotenv/config';
import { loadConfig } from '../config.js';
import { closePool, createPool } from '../db/connection.js';
import { closeDb, initDb } from '../db/index.js';
import { MultiAssetRunDispatcher } from './dispatcher.js';
import { promoteReadyMultiAssetRetries, recoverAndListQueuedMultiAssetRuns } from './repository.js';
import { processMultiAssetRun } from './runService.js';

const config = loadConfig();
const pool = createPool(config);
initDb(pool);
let stopping = false;
const dispatcher = new MultiAssetRunDispatcher(
  (runId) => processMultiAssetRun(runId, {
    snapshotRoot: config.RESEARCH_SNAPSHOT_ROOT,
    pythonExecutable: config.FACTOR_MINER_PYTHON,
  }),
  (runId, error) => console.error('[multi-asset-worker]', runId, error),
  Math.max(1, Number(process.env.MULTI_ASSET_WORKER_CONCURRENCY ?? 2)),
);

async function poll(): Promise<void> {
  if (stopping) return;
  const recovered = await recoverAndListQueuedMultiAssetRuns(500);
  const retries = await promoteReadyMultiAssetRetries(500);
  for (const runId of new Set([...recovered, ...retries])) dispatcher.enqueue(runId);
}

const timer = setInterval(() => void poll().catch((error) => console.error(error)), 1_000);
timer.unref?.();
await poll();
console.log('[multi-asset-worker] persistent queue worker started');

async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  const deadline = Date.now() + 30_000;
  while (dispatcher.stats().active > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await closeDb();
  await closePool(pool);
}

process.once('SIGINT', () => void shutdown().finally(() => process.exit(0)));
process.once('SIGTERM', () => void shutdown().finally(() => process.exit(0)));
await new Promise<void>(() => undefined);
