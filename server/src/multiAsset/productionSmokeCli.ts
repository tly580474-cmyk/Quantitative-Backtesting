import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { loadConfig } from '../config.js';
import { closePool, createPool } from '../db/connection.js';
import { closeDb, getDb, initDb, schema } from '../db/index.js';
import {
  cancelClaimedMultiAssetRun,
  claimQueuedMultiAssetRun,
  createQueuedMultiAssetRun,
  getMultiAssetRun,
  listMultiAssetPlanVersions,
  listMultiAssetRunArtifacts,
  listMultiAssetRunEvents,
  manuallyRetryMultiAssetRun,
  promoteReadyMultiAssetRetries,
  requestMultiAssetRunCancellation,
  settleMultiAssetRunFailure,
} from './repository.js';
import { processMultiAssetRun } from './runService.js';

const config = loadConfig();
const pool = createPool(config);
initDb(pool);
try {
  const plan = (await listMultiAssetPlanVersions(1))[0];
  if (!plan) throw new Error('PRODUCTION_SMOKE_PLAN_REQUIRED');
  const prefix = `m4-production:${Date.now()}`;

  const queuedCancel = await createQueuedMultiAssetRun({
    planVersionId: plan.id, idempotencyKey: `${prefix}:queued-cancel`, initialCash: 1_000_000,
  });
  if (queuedCancel.type !== 'run') throw new Error('QUEUE_CANCEL_CREATE_FAILED');
  const cancelled = await requestMultiAssetRunCancellation(queuedCancel.run.id);
  if (cancelled?.status !== 'cancelled') throw new Error('QUEUE_CANCEL_FAILED');

  const runningCancel = await createQueuedMultiAssetRun({
    planVersionId: plan.id, idempotencyKey: `${prefix}:running-cancel`, initialCash: 1_000_000,
  });
  if (runningCancel.type !== 'run') throw new Error('RUNNING_CANCEL_CREATE_FAILED');
  const cancelToken = randomUUID();
  if (!await claimQueuedMultiAssetRun(runningCancel.run.id, cancelToken, 60_000)) throw new Error('RUNNING_CANCEL_CLAIM_FAILED');
  await requestMultiAssetRunCancellation(runningCancel.run.id);
  if (!await cancelClaimedMultiAssetRun(runningCancel.run.id, cancelToken)) throw new Error('RUNNING_CANCEL_SETTLE_FAILED');

  const retryRun = await createQueuedMultiAssetRun({
    planVersionId: plan.id, idempotencyKey: `${prefix}:retry`, initialCash: 1_000_000,
  });
  if (retryRun.type !== 'run') throw new Error('RETRY_CREATE_FAILED');
  const retryToken = randomUUID();
  if (!await claimQueuedMultiAssetRun(retryRun.run.id, retryToken, 60_000)) throw new Error('RETRY_CLAIM_FAILED');
  if (await settleMultiAssetRunFailure({
    id: retryRun.run.id, workerToken: retryToken, errorCode: 'PYTHON_PLAN_WORKER_TIMEOUT',
    errorMessage: 'fault injection', retryable: true,
  }) !== 'retry_wait') throw new Error('RETRY_WAIT_FAILED');
  await getDb().update(schema.multiAssetRuns).set({ nextAttemptAt: '2000-01-01T00:00:00.000Z' })
    .where(eq(schema.multiAssetRuns.id, retryRun.run.id));
  if (!(await promoteReadyMultiAssetRetries()).includes(retryRun.run.id)) throw new Error('RETRY_PROMOTION_FAILED');

  const deadRun = await createQueuedMultiAssetRun({
    planVersionId: plan.id, idempotencyKey: `${prefix}:dead`, initialCash: 1_000_000,
  });
  if (deadRun.type !== 'run') throw new Error('DEAD_CREATE_FAILED');
  const deadToken = randomUUID();
  if (!await claimQueuedMultiAssetRun(deadRun.run.id, deadToken, 60_000)) throw new Error('DEAD_CLAIM_FAILED');
  if (await settleMultiAssetRunFailure({
    id: deadRun.run.id, workerToken: deadToken, errorCode: 'INVALID_PLAN',
    errorMessage: 'non retryable fault injection', retryable: false,
  }) !== 'dead_letter') throw new Error('DEAD_LETTER_FAILED');
  if ((await manuallyRetryMultiAssetRun(deadRun.run.id))?.status !== 'queued') throw new Error('MANUAL_RETRY_FAILED');

  const fullRun = await createQueuedMultiAssetRun({
    planVersionId: plan.id, idempotencyKey: `${prefix}:full`, initialCash: 1_000_000,
  });
  if (fullRun.type !== 'run') throw new Error('FULL_CREATE_FAILED');
  const completed = await processMultiAssetRun(fullRun.run.id, {
    snapshotRoot: config.RESEARCH_SNAPSHOT_ROOT, pythonExecutable: config.FACTOR_MINER_PYTHON,
  });
  const events = await listMultiAssetRunEvents(fullRun.run.id);
  const artifacts = await listMultiAssetRunArtifacts(fullRun.run.id);
  const artifactKinds = new Set(artifacts.map((artifact) => artifact.kind));
  if (completed?.status !== 'completed'
    || !(['rebalance_plan', 'execution_result', 'extension_report'] as const)
      .every((kind) => artifactKinds.has(kind))
    || events.length < 5) {
    throw new Error(`FULL_RUN_INCOMPLETE:${completed?.status}:${artifacts.length}:${events.length}`);
  }

  process.stdout.write(`${JSON.stringify({
    status: 'm4_production_smoke_passed',
    queuedCancellation: (await getMultiAssetRun(queuedCancel.run.id))?.status,
    runningCancellation: (await getMultiAssetRun(runningCancel.run.id))?.status,
    automaticRetry: (await getMultiAssetRun(retryRun.run.id))?.status,
    deadLetterManualRetry: (await getMultiAssetRun(deadRun.run.id))?.status,
    completedRun: completed.id,
    dailyLedgerPoints: Array.isArray((completed.executionResult as { ledger?: unknown[] })?.ledger)
      ? (completed.executionResult as { ledger: unknown[] }).ledger.length : 0,
    artifacts: artifacts.map((item) => ({ kind: item.kind, hash: item.contentHash, bytes: item.byteSize })),
    eventCount: events.length,
  }, null, 2)}\n`);
} finally {
  await closeDb();
  await closePool(pool);
}
