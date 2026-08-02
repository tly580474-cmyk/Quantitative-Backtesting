import 'dotenv/config';
import { loadConfig } from '../config.js';
import { hostname } from 'node:os';
import { closePool, createPool } from '../db/connection.js';
import { closeDb, initDb } from '../db/index.js';
import { MultiAssetRunDispatcher } from './dispatcher.js';
import { promoteReadyMultiAssetRetries, recoverAndListQueuedMultiAssetRuns } from './repository.js';
import { processMultiAssetRun } from './runService.js';
import {
  heartbeatMultiAssetWorker,
  registerMultiAssetWorker,
  stopMultiAssetWorker,
} from './operations.js';

const config = loadConfig();
const pool = createPool(config);
initDb(pool);
let stopping = false;
const concurrency = Math.max(1, Number(config.MULTI_ASSET_WORKER_CONCURRENCY));
const dispatcher = new MultiAssetRunDispatcher(
  (runId) => processMultiAssetRun(runId, {
    snapshotRoot: config.RESEARCH_SNAPSHOT_ROOT,
    pythonExecutable: config.FACTOR_MINER_PYTHON,
  }),
  (runId, error) => console.error('[multi-asset-worker]', runId, error),
  concurrency,
);
let pollInFlight: Promise<void> = Promise.resolve();
let heartbeatInFlight: Promise<void> = Promise.resolve();

async function poll(): Promise<void> {
  if (stopping) return;
  const recovered = await recoverAndListQueuedMultiAssetRuns(500);
  const retries = await promoteReadyMultiAssetRetries(500);
  for (const runId of new Set([...recovered, ...retries])) dispatcher.enqueue(runId);
}

const workerId = await registerMultiAssetWorker({
  mode: 'standalone', hostname: hostname(), pid: process.pid, concurrency,
});
const schedulePoll = () => {
  if (stopping) return;
  pollInFlight = pollInFlight.then(poll).catch((error) => console.error(error));
};
const timer = setInterval(schedulePoll, Math.max(250, Number(config.MULTI_ASSET_POLL_INTERVAL_MS)));
timer.unref?.();
const heartbeatTimer = setInterval(() => {
  if (stopping) return;
  heartbeatInFlight = heartbeatInFlight
    .then(() => heartbeatMultiAssetWorker(workerId, 'ready', dispatcher.stats()))
    .catch((error) => console.error('[multi-asset-worker] heartbeat failed', error));
}, Math.max(1_000, Number(config.MULTI_ASSET_WORKER_HEARTBEAT_MS)));
heartbeatTimer.unref?.();
await poll();
console.log('[multi-asset-worker] persistent queue worker started');

async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  clearInterval(heartbeatTimer);
  dispatcher.stopAccepting();
  await Promise.allSettled([pollInFlight, heartbeatInFlight]);
  await heartbeatMultiAssetWorker(workerId, 'draining').catch(() => undefined);
  const drained = await dispatcher.drain(Number(config.MULTI_ASSET_SHUTDOWN_GRACE_MS));
  if (!drained) console.warn('[multi-asset-worker] shutdown grace expired; leases will be recovered');
  await stopMultiAssetWorker(workerId).catch(() => undefined);
  await closeDb();
  await closePool(pool);
}

process.once('SIGINT', () => void shutdown().finally(() => process.exit(0)));
process.once('SIGTERM', () => void shutdown().finally(() => process.exit(0)));
await new Promise<void>(() => undefined);
