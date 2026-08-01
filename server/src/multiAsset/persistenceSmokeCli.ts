import 'dotenv/config';
import { loadConfig } from '../config.js';
import { closePool, createPool } from '../db/connection.js';
import { closeDb, initDb } from '../db/index.js';
import { createQueuedMultiAssetRun, getMultiAssetRun } from './repository.js';
import { freezeSnapshotMultiAssetPlan, processMultiAssetRun } from './runService.js';

const config = loadConfig();
const pool = createPool(config);
initDb(pool);
try {
  const frozen = await freezeSnapshotMultiAssetPlan({
    name: 'M4 持久化基础流程冒烟',
    snapshotRoot: config.RESEARCH_SNAPSHOT_ROOT,
    config: {
      universeSpec: { type: 'index', indexCode: '000300' }, startDate: '2026-06-01', endDate: '2026-07-30',
      frequency: 'weekly', topN: 10, weighting: 'equal',
      maxGrossExposure: 0.95, maxSingleWeight: 0.1, minCashWeight: 0.05,
    },
  });
  const idempotencyKey = `m4-persistence-smoke:${frozen.plan.id}`;
  const queued = await createQueuedMultiAssetRun({
    planVersionId: frozen.plan.id, idempotencyKey, initialCash: 1_000_000,
  });
  if (queued.type !== 'run') throw new Error(`PERSISTENCE_SMOKE_QUEUE_FAILED:${queued.type}`);
  const completed = await processMultiAssetRun(queued.run.id, {
    snapshotRoot: config.RESEARCH_SNAPSHOT_ROOT,
    pythonExecutable: config.FACTOR_MINER_PYTHON,
  });
  if (!completed || completed.status !== 'completed' || !completed.resultHash) {
    throw new Error(`PERSISTENCE_SMOKE_RUN_FAILED:${completed?.errorCode ?? completed?.status ?? 'missing'}`);
  }
  const replay = await createQueuedMultiAssetRun({
    planVersionId: frozen.plan.id, idempotencyKey, initialCash: 1_000_000,
  });
  if (replay.type !== 'run' || !replay.reused || replay.run.id !== queued.run.id) {
    throw new Error('PERSISTENCE_SMOKE_IDEMPOTENT_REPLAY_FAILED');
  }
  const conflict = await createQueuedMultiAssetRun({
    planVersionId: frozen.plan.id, idempotencyKey, initialCash: 1_000_001,
  });
  if (conflict.type !== 'conflict') throw new Error('PERSISTENCE_SMOKE_CONFLICT_NOT_DETECTED');
  const stored = await getMultiAssetRun(queued.run.id);
  process.stdout.write(`${JSON.stringify({
    status: 'persistence_foundation_smoke_passed',
    planId: frozen.plan.id,
    planHash: frozen.plan.planHash,
    planReused: frozen.reused,
    runId: stored?.id,
    runStatus: stored?.status,
    resultHash: stored?.resultHash,
    idempotentReplay: true,
    conflictingReplayRejected: true,
  }, null, 2)}\n`);
} finally {
  await closeDb();
  await closePool(pool);
}
