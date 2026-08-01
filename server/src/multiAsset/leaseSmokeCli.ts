import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { loadConfig } from '../config.js';
import { closePool, createPool } from '../db/connection.js';
import { closeDb, getDb, initDb, schema } from '../db/index.js';
import {
  claimQueuedMultiAssetRun,
  createQueuedMultiAssetRun,
  failMultiAssetRun,
  recoverAndListQueuedMultiAssetRuns,
  updateMultiAssetRunProgress,
} from './repository.js';
import { freezeSnapshotMultiAssetPlan } from './runService.js';

const config = loadConfig();
const pool = createPool(config);
initDb(pool);

try {
  const frozen = await freezeSnapshotMultiAssetPlan({
    name: 'M4 worker lease concurrency smoke',
    snapshotRoot: config.RESEARCH_SNAPSHOT_ROOT,
    config: {
      indexCode: '000300', startDate: '2026-06-01', endDate: '2026-07-30',
      frequency: 'weekly', topN: 10, weighting: 'equal',
      maxGrossExposure: 0.95, maxSingleWeight: 0.1, minCashWeight: 0.05,
    },
  });
  const queued = await createQueuedMultiAssetRun({
    planVersionId: frozen.plan.id,
    idempotencyKey: `m4-lease-smoke:${crypto.randomUUID()}`,
    initialCash: 1_000_000,
  });
  if (queued.type !== 'run') throw new Error(`LEASE_SMOKE_QUEUE_FAILED:${queued.type}`);

  const [claimA, claimB] = await Promise.all([
    claimQueuedMultiAssetRun(queued.run.id, 'worker-a', 60_000),
    claimQueuedMultiAssetRun(queued.run.id, 'worker-b', 60_000),
  ]);
  const winners = [claimA, claimB].filter(Boolean);
  if (winners.length !== 1) throw new Error(`LEASE_SMOKE_NON_ATOMIC_CLAIM:${winners.length}`);
  const firstToken = claimA ? 'worker-a' : 'worker-b';

  await getDb().update(schema.multiAssetRuns).set({
    leaseExpiresAt: '2000-01-01T00:00:00.000Z',
  }).where(eq(schema.multiAssetRuns.id, queued.run.id));
  const recovered = await recoverAndListQueuedMultiAssetRuns();
  if (!recovered.includes(queued.run.id)) throw new Error('LEASE_SMOKE_EXPIRED_RUN_NOT_RECOVERED');

  const secondToken = 'worker-after-restart';
  const reclaimed = await claimQueuedMultiAssetRun(queued.run.id, secondToken, 60_000);
  if (!reclaimed) throw new Error('LEASE_SMOKE_RECLAIM_FAILED');
  const staleWriteAccepted = await updateMultiAssetRunProgress(
    queued.run.id, firstToken, { stage: 'stale_worker_write', percent: 99 }, 60_000,
  );
  const ownerWriteAccepted = await updateMultiAssetRunProgress(
    queued.run.id, secondToken, { stage: 'lease_smoke_verified', percent: 50 }, 60_000,
  );
  if (staleWriteAccepted || !ownerWriteAccepted) {
    throw new Error('LEASE_SMOKE_FENCING_TOKEN_FAILED');
  }
  if (!await failMultiAssetRun(
    queued.run.id, secondToken, 'LEASE_SMOKE_CLEANUP', 'integration smoke completed',
  )) {
    throw new Error('LEASE_SMOKE_CLEANUP_FAILED');
  }

  process.stdout.write(`${JSON.stringify({
    status: 'multi_asset_lease_smoke_passed',
    runId: queued.run.id,
    concurrentClaimWinners: winners.length,
    expiredRunRecovered: true,
    staleWorkerFenced: true,
    attemptCount: reclaimed.attemptCount,
  }, null, 2)}\n`);
} finally {
  await closeDb();
  await closePool(pool);
}
