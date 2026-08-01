import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { canonicalHash } from '../experiments/schema.js';
import { hashMultiAssetPlan, multiAssetPlanSchema, type MultiAssetPlan, type RebalancePlan } from './schema.js';
import { snapshotMultiAssetConfigSchema, type SnapshotMultiAssetConfig } from './snapshotInput.js';
import type { PortfolioExecutionResult } from './execution.js';

const { multiAssetPlanVersions, multiAssetRuns, multiAssetRunEvents, multiAssetRunArtifacts } = schema;

export type StoredMultiAssetPlan = typeof multiAssetPlanVersions.$inferSelect;
export type StoredMultiAssetRun = typeof multiAssetRuns.$inferSelect;
export type StoredMultiAssetRunEvent = typeof multiAssetRunEvents.$inferSelect;
export type StoredMultiAssetRunArtifact = typeof multiAssetRunArtifacts.$inferSelect;

export async function appendMultiAssetRunEvent(input: {
  runId: string; eventType: string; stage?: string | null; percent?: number | null; payload?: unknown;
}): Promise<void> {
  await getDb().insert(multiAssetRunEvents).values({
    runId: input.runId,
    eventType: input.eventType.slice(0, 40),
    stage: input.stage?.slice(0, 80) ?? null,
    percent: input.percent ?? null,
    payload: input.payload ?? null,
    createdAt: new Date().toISOString(),
  });
}

function affectedRows(result: unknown): number {
  const header = Array.isArray(result) ? result[0] : result;
  return Number((header as { affectedRows?: number } | undefined)?.affectedRows ?? 0);
}

export async function storeFrozenMultiAssetPlan(input: {
  name: string;
  plan: MultiAssetPlan;
  snapshotConfig: SnapshotMultiAssetConfig;
}) {
  const plan = multiAssetPlanSchema.parse(input.plan);
  const snapshotConfig = snapshotMultiAssetConfigSchema.parse(input.snapshotConfig);
  const planHash = hashMultiAssetPlan(plan);
  const [existing] = await getDb().select().from(multiAssetPlanVersions)
    .where(eq(multiAssetPlanVersions.planHash, planHash)).limit(1);
  if (existing) return { plan: existing, reused: true };
  const now = new Date().toISOString();
  const row = {
    id: randomUUID(), name: input.name, status: 'frozen', snapshotId: plan.snapshotId,
    planHash, plan, snapshotConfig, createdAt: now, updatedAt: now,
  };
  try {
    await getDb().insert(multiAssetPlanVersions).values(row);
    return { plan: row, reused: false };
  } catch (error) {
    const [raced] = await getDb().select().from(multiAssetPlanVersions)
      .where(eq(multiAssetPlanVersions.planHash, planHash)).limit(1);
    if (raced) return { plan: raced, reused: true };
    throw error;
  }
}

export async function getMultiAssetPlanVersion(id: string): Promise<StoredMultiAssetPlan | null> {
  const [row] = await getDb().select().from(multiAssetPlanVersions)
    .where(eq(multiAssetPlanVersions.id, id)).limit(1);
  return row ?? null;
}

export async function listMultiAssetPlanVersions(limit = 50, offset = 0): Promise<StoredMultiAssetPlan[]> {
  return getDb().select().from(multiAssetPlanVersions)
    .orderBy(desc(multiAssetPlanVersions.createdAt)).limit(Math.max(1, Math.min(200, limit)))
    .offset(Math.max(0, offset));
}

export async function countMultiAssetPlanVersions(): Promise<number> {
  const [row] = await getDb().select({ count: sql<number>`count(*)` }).from(multiAssetPlanVersions);
  return Number(row?.count ?? 0);
}

export function buildMultiAssetRunInputHash(input: {
  planVersionId: string;
  planHash: string;
  initialCash: number;
}): string {
  return canonicalHash(input);
}

export async function createQueuedMultiAssetRun(input: {
  planVersionId: string;
  idempotencyKey: string;
  initialCash: number;
}) {
  const plan = await getMultiAssetPlanVersion(input.planVersionId);
  if (!plan) return { type: 'plan_not_found' as const };
  const inputHash = buildMultiAssetRunInputHash({
    planVersionId: plan.id, planHash: plan.planHash, initialCash: input.initialCash,
  });
  const [existing] = await getDb().select().from(multiAssetRuns)
    .where(eq(multiAssetRuns.idempotencyKey, input.idempotencyKey)).limit(1);
  if (existing) return existing.inputHash === inputHash
    ? { type: 'run' as const, run: existing, reused: true }
    : { type: 'conflict' as const, run: existing };
  const now = new Date().toISOString();
  const row = {
    id: randomUUID(), planVersionId: plan.id, status: 'queued',
    idempotencyKey: input.idempotencyKey, inputHash, initialCash: input.initialCash,
    progress: { stage: 'queued', percent: 0 },
    workerToken: null, leaseExpiresAt: null, attemptCount: 0, maxAttempts: 3,
    nextAttemptAt: null, cancelRequestedAt: null, cancelledAt: null, parentRunId: null,
    rebalancePlan: null, executionResult: null, resultHash: null,
    errorCode: null, errorMessage: null, createdAt: now,
    startedAt: null, completedAt: null, updatedAt: now,
  };
  try {
    await getDb().insert(multiAssetRuns).values(row);
    await appendMultiAssetRunEvent({ runId: row.id, eventType: 'queued', stage: 'queued', percent: 0 });
    return { type: 'run' as const, run: row, reused: false };
  } catch (error) {
    const [raced] = await getDb().select().from(multiAssetRuns)
      .where(eq(multiAssetRuns.idempotencyKey, input.idempotencyKey)).limit(1);
    if (!raced) throw error;
    return raced.inputHash === inputHash
      ? { type: 'run' as const, run: raced, reused: true }
      : { type: 'conflict' as const, run: raced };
  }
}

export async function getMultiAssetRun(id: string): Promise<StoredMultiAssetRun | null> {
  const [row] = await getDb().select().from(multiAssetRuns)
    .where(eq(multiAssetRuns.id, id)).limit(1);
  return row ?? null;
}

export async function listMultiAssetRuns(
  planVersionId?: string,
  limit = 50,
  offset = 0,
): Promise<StoredMultiAssetRun[]> {
  // List endpoints must not sort or transfer the large result JSON columns. A completed
  // portfolio can contain thousands of ledger/order entries; detail is loaded by id.
  const fields = {
    id: multiAssetRuns.id,
    planVersionId: multiAssetRuns.planVersionId,
    status: multiAssetRuns.status,
    idempotencyKey: multiAssetRuns.idempotencyKey,
    inputHash: multiAssetRuns.inputHash,
    initialCash: multiAssetRuns.initialCash,
    progress: multiAssetRuns.progress,
    workerToken: multiAssetRuns.workerToken,
    leaseExpiresAt: multiAssetRuns.leaseExpiresAt,
    attemptCount: multiAssetRuns.attemptCount,
    maxAttempts: multiAssetRuns.maxAttempts,
    nextAttemptAt: multiAssetRuns.nextAttemptAt,
    cancelRequestedAt: multiAssetRuns.cancelRequestedAt,
    cancelledAt: multiAssetRuns.cancelledAt,
    parentRunId: multiAssetRuns.parentRunId,
    resultHash: multiAssetRuns.resultHash,
    errorCode: multiAssetRuns.errorCode,
    errorMessage: multiAssetRuns.errorMessage,
    createdAt: multiAssetRuns.createdAt,
    startedAt: multiAssetRuns.startedAt,
    completedAt: multiAssetRuns.completedAt,
    updatedAt: multiAssetRuns.updatedAt,
  };
  const query = getDb().select(fields).from(multiAssetRuns);
  const rows = await (planVersionId
    ? query.where(eq(multiAssetRuns.planVersionId, planVersionId))
      .orderBy(desc(multiAssetRuns.createdAt)).limit(Math.max(1, Math.min(200, limit))).offset(Math.max(0, offset))
    : query.orderBy(desc(multiAssetRuns.createdAt)).limit(Math.max(1, Math.min(200, limit))).offset(Math.max(0, offset)));
  return rows.map((row) => ({ ...row, rebalancePlan: null, executionResult: null }));
}

export async function countMultiAssetRuns(planVersionId?: string): Promise<number> {
  const query = getDb().select({ count: sql<number>`count(*)` }).from(multiAssetRuns);
  const [row] = planVersionId ? await query.where(eq(multiAssetRuns.planVersionId, planVersionId)) : await query;
  return Number(row?.count ?? 0);
}

export async function claimQueuedMultiAssetRun(
  id: string,
  workerToken: string,
  leaseDurationMs: number,
): Promise<StoredMultiAssetRun | null> {
  const now = new Date().toISOString();
  const leaseExpiresAt = new Date(Date.now() + leaseDurationMs).toISOString();
  const result = await getDb().update(multiAssetRuns).set({
    status: 'running', progress: { stage: 'loading_snapshot', percent: 5 },
    workerToken, leaseExpiresAt, attemptCount: sql`${multiAssetRuns.attemptCount} + 1`,
    startedAt: now, completedAt: null, updatedAt: now, nextAttemptAt: null,
  }).where(and(eq(multiAssetRuns.id, id), eq(multiAssetRuns.status, 'queued'), isNull(multiAssetRuns.cancelRequestedAt)));
  if (affectedRows(result) !== 1) return null;
  await appendMultiAssetRunEvent({ runId: id, eventType: 'claimed', stage: 'loading_snapshot', percent: 5, payload: { workerToken } });
  return getMultiAssetRun(id);
}

export async function updateMultiAssetRunProgress(
  id: string,
  workerToken: string,
  progress: { stage: string; percent: number },
  leaseDurationMs: number,
): Promise<boolean> {
  const updated = affectedRows(await getDb().update(multiAssetRuns).set({
    progress,
    leaseExpiresAt: new Date(Date.now() + leaseDurationMs).toISOString(),
    updatedAt: new Date().toISOString(),
  }).where(and(
    eq(multiAssetRuns.id, id),
    eq(multiAssetRuns.status, 'running'),
    eq(multiAssetRuns.workerToken, workerToken),
  ))) === 1;
  if (updated) await appendMultiAssetRunEvent({ runId: id, eventType: 'progress', ...progress });
  return updated;
}

export async function renewMultiAssetRunLease(
  id: string,
  workerToken: string,
  leaseDurationMs: number,
): Promise<boolean> {
  const now = new Date().toISOString();
  return affectedRows(await getDb().update(multiAssetRuns).set({
    leaseExpiresAt: new Date(Date.now() + leaseDurationMs).toISOString(), updatedAt: now,
  }).where(and(
    eq(multiAssetRuns.id, id),
    eq(multiAssetRuns.status, 'running'),
    eq(multiAssetRuns.workerToken, workerToken),
  ))) === 1;
}

export async function completeMultiAssetRun(input: {
  id: string;
  workerToken: string;
  rebalancePlan: RebalancePlan;
  executionResult: PortfolioExecutionResult;
  resultHash: string;
}): Promise<boolean> {
  const now = new Date().toISOString();
  const updated = affectedRows(await getDb().update(multiAssetRuns).set({
    status: 'completed', progress: { stage: 'completed', percent: 100 },
    rebalancePlan: input.rebalancePlan, executionResult: input.executionResult,
    resultHash: input.resultHash, errorCode: null, errorMessage: null,
    workerToken: null, leaseExpiresAt: null, completedAt: now, updatedAt: now,
  }).where(and(
    eq(multiAssetRuns.id, input.id),
    eq(multiAssetRuns.status, 'running'),
    eq(multiAssetRuns.workerToken, input.workerToken),
  ))) === 1;
  if (updated) await appendMultiAssetRunEvent({ runId: input.id, eventType: 'completed', stage: 'completed', percent: 100, payload: { resultHash: input.resultHash } });
  return updated;
}

export async function failMultiAssetRun(
  id: string,
  workerToken: string,
  errorCode: string,
  errorMessage: string,
): Promise<boolean> {
  const now = new Date().toISOString();
  return affectedRows(await getDb().update(multiAssetRuns).set({
    status: 'failed', progress: { stage: 'failed', percent: 100 },
    errorCode: errorCode.slice(0, 64), errorMessage: errorMessage.slice(0, 1000),
    workerToken: null, leaseExpiresAt: null, completedAt: now, updatedAt: now,
  }).where(and(
    eq(multiAssetRuns.id, id),
    eq(multiAssetRuns.status, 'running'),
    eq(multiAssetRuns.workerToken, workerToken),
  ))) === 1;
}

export async function settleMultiAssetRunFailure(input: {
  id: string; workerToken: string; errorCode: string; errorMessage: string; retryable: boolean;
}): Promise<'retry_wait' | 'dead_letter' | 'lost'> {
  const run = await getMultiAssetRun(input.id);
  if (!run || run.status !== 'running' || run.workerToken !== input.workerToken) return 'lost';
  const retry = input.retryable && run.attemptCount < run.maxAttempts;
  const status = retry ? 'retry_wait' : 'dead_letter';
  const delayMs = Math.min(60_000, 1_000 * 2 ** Math.max(0, run.attemptCount - 1));
  const nextAttemptAt = retry ? new Date(Date.now() + delayMs).toISOString() : null;
  const now = new Date().toISOString();
  const updated = affectedRows(await getDb().update(multiAssetRuns).set({
    status,
    progress: { stage: status, percent: 100 },
    errorCode: input.errorCode.slice(0, 64),
    errorMessage: input.errorMessage.slice(0, 1000),
    workerToken: null,
    leaseExpiresAt: null,
    nextAttemptAt,
    completedAt: retry ? null : now,
    updatedAt: now,
  }).where(and(
    eq(multiAssetRuns.id, input.id),
    eq(multiAssetRuns.status, 'running'),
    eq(multiAssetRuns.workerToken, input.workerToken),
  )));
  if (updated !== 1) return 'lost';
  await appendMultiAssetRunEvent({
    runId: input.id, eventType: status, stage: status, percent: 100,
    payload: { errorCode: input.errorCode, retryable: input.retryable, nextAttemptAt },
  });
  return status;
}

export async function requestMultiAssetRunCancellation(id: string): Promise<StoredMultiAssetRun | null> {
  const run = await getMultiAssetRun(id);
  if (!run) return null;
  if (['completed', 'failed', 'dead_letter', 'cancelled'].includes(run.status)) return run;
  const now = new Date().toISOString();
  if (run.status === 'queued' || run.status === 'retry_wait') {
    await getDb().update(multiAssetRuns).set({
      status: 'cancelled', progress: { stage: 'cancelled', percent: 100 },
      cancelRequestedAt: now, cancelledAt: now, completedAt: now, updatedAt: now,
    }).where(and(eq(multiAssetRuns.id, id), eq(multiAssetRuns.status, run.status)));
    await appendMultiAssetRunEvent({ runId: id, eventType: 'cancelled', stage: 'cancelled', percent: 100 });
  } else {
    await getDb().update(multiAssetRuns).set({ cancelRequestedAt: now, updatedAt: now })
      .where(and(eq(multiAssetRuns.id, id), eq(multiAssetRuns.status, 'running')));
    await appendMultiAssetRunEvent({ runId: id, eventType: 'cancel_requested', stage: run.progress && typeof run.progress === 'object' && 'stage' in run.progress ? String(run.progress.stage) : null });
  }
  return getMultiAssetRun(id);
}

export async function cancelClaimedMultiAssetRun(id: string, workerToken: string): Promise<boolean> {
  const now = new Date().toISOString();
  const updated = affectedRows(await getDb().update(multiAssetRuns).set({
    status: 'cancelled', progress: { stage: 'cancelled', percent: 100 },
    workerToken: null, leaseExpiresAt: null, cancelledAt: now, completedAt: now, updatedAt: now,
  }).where(and(eq(multiAssetRuns.id, id), eq(multiAssetRuns.status, 'running'), eq(multiAssetRuns.workerToken, workerToken))));
  if (updated) await appendMultiAssetRunEvent({ runId: id, eventType: 'cancelled', stage: 'cancelled', percent: 100 });
  return updated === 1;
}

export async function promoteReadyMultiAssetRetries(limit = 100): Promise<string[]> {
  const now = new Date().toISOString();
  await getDb().update(multiAssetRuns).set({
    status: 'queued', progress: { stage: 'queued', percent: 0 }, nextAttemptAt: null, updatedAt: now,
  }).where(and(eq(multiAssetRuns.status, 'retry_wait'), lte(multiAssetRuns.nextAttemptAt, now), isNull(multiAssetRuns.cancelRequestedAt)));
  const rows = await getDb().select({ id: multiAssetRuns.id }).from(multiAssetRuns)
    .where(and(eq(multiAssetRuns.status, 'queued'), isNull(multiAssetRuns.cancelRequestedAt)))
    .orderBy(asc(multiAssetRuns.createdAt)).limit(Math.max(1, Math.min(1000, limit)));
  return rows.map((row) => row.id);
}

export async function manuallyRetryMultiAssetRun(id: string): Promise<StoredMultiAssetRun | null> {
  const run = await getMultiAssetRun(id);
  if (!run) return null;
  if (!['failed', 'dead_letter', 'cancelled'].includes(run.status)) return run;
  const now = new Date().toISOString();
  await getDb().update(multiAssetRuns).set({
    status: 'queued', progress: { stage: 'queued', percent: 0 }, attemptCount: 0,
    nextAttemptAt: null, cancelRequestedAt: null, cancelledAt: null,
    errorCode: null, errorMessage: null, completedAt: null, updatedAt: now,
  }).where(and(eq(multiAssetRuns.id, id), eq(multiAssetRuns.status, run.status)));
  await appendMultiAssetRunEvent({ runId: id, eventType: 'manual_retry', stage: 'queued', percent: 0 });
  return getMultiAssetRun(id);
}

export async function listMultiAssetRunEvents(runId: string, afterId = 0, limit = 200): Promise<StoredMultiAssetRunEvent[]> {
  return getDb().select().from(multiAssetRunEvents)
    .where(and(eq(multiAssetRunEvents.runId, runId), sql`${multiAssetRunEvents.id} > ${afterId}`))
    .orderBy(asc(multiAssetRunEvents.id)).limit(Math.max(1, Math.min(1000, limit)));
}

export async function storeMultiAssetRunArtifact(input: Omit<StoredMultiAssetRunArtifact, 'id' | 'createdAt'>): Promise<StoredMultiAssetRunArtifact> {
  const row = { ...input, id: randomUUID(), createdAt: new Date().toISOString() };
  await getDb().insert(multiAssetRunArtifacts).values(row).onDuplicateKeyUpdate({ set: {
    contentHash: row.contentHash, storageUri: row.storageUri, byteSize: row.byteSize,
    mediaType: row.mediaType, createdAt: row.createdAt,
  } });
  const [stored] = await getDb().select().from(multiAssetRunArtifacts)
    .where(and(eq(multiAssetRunArtifacts.runId, input.runId), eq(multiAssetRunArtifacts.kind, input.kind))).limit(1);
  return stored!;
}

export async function listMultiAssetRunArtifacts(runId: string): Promise<StoredMultiAssetRunArtifact[]> {
  return getDb().select().from(multiAssetRunArtifacts).where(eq(multiAssetRunArtifacts.runId, runId));
}

export async function getMultiAssetRunArtifact(id: string): Promise<StoredMultiAssetRunArtifact | null> {
  const [row] = await getDb().select().from(multiAssetRunArtifacts)
    .where(eq(multiAssetRunArtifacts.id, id)).limit(1);
  return row ?? null;
}

export async function listExpiredMultiAssetRunArtifacts(
  completedBefore: string,
  limit = 500,
): Promise<StoredMultiAssetRunArtifact[]> {
  return getDb().select({
    id: multiAssetRunArtifacts.id,
    runId: multiAssetRunArtifacts.runId,
    kind: multiAssetRunArtifacts.kind,
    contentHash: multiAssetRunArtifacts.contentHash,
    storageUri: multiAssetRunArtifacts.storageUri,
    byteSize: multiAssetRunArtifacts.byteSize,
    mediaType: multiAssetRunArtifacts.mediaType,
    createdAt: multiAssetRunArtifacts.createdAt,
  }).from(multiAssetRunArtifacts)
    .innerJoin(multiAssetRuns, eq(multiAssetRunArtifacts.runId, multiAssetRuns.id))
    .where(and(
      inArray(multiAssetRuns.status, ['completed', 'failed', 'dead_letter', 'cancelled']),
      lte(multiAssetRuns.completedAt, completedBefore),
    ))
    .orderBy(asc(multiAssetRunArtifacts.createdAt))
    .limit(Math.max(1, Math.min(5000, limit)));
}

export async function deleteMultiAssetRunArtifact(id: string): Promise<void> {
  await getDb().delete(multiAssetRunArtifacts).where(eq(multiAssetRunArtifacts.id, id));
}

export async function recoverAndListQueuedMultiAssetRuns(limit = 100): Promise<string[]> {
  const now = new Date().toISOString();
  await getDb().update(multiAssetRuns).set({
    status: 'queued',
    progress: { stage: 'recovered_after_restart', percent: 0 },
    workerToken: null,
    leaseExpiresAt: null,
    completedAt: null,
    updatedAt: now,
  }).where(and(
    eq(multiAssetRuns.status, 'running'),
    or(isNull(multiAssetRuns.leaseExpiresAt), lte(multiAssetRuns.leaseExpiresAt, now)),
  ));
  const rows = await getDb().select({ id: multiAssetRuns.id }).from(multiAssetRuns)
    .where(eq(multiAssetRuns.status, 'queued'))
    .orderBy(asc(multiAssetRuns.createdAt))
    .limit(Math.max(1, Math.min(1000, limit)));
  return rows.map((row) => row.id);
}
