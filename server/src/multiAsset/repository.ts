import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, isNull, lte, or, sql } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { canonicalHash } from '../experiments/schema.js';
import { hashMultiAssetPlan, multiAssetPlanSchema, type MultiAssetPlan, type RebalancePlan } from './schema.js';
import { snapshotMultiAssetConfigSchema, type SnapshotMultiAssetConfig } from './snapshotInput.js';
import type { PortfolioExecutionResult } from './execution.js';

const { multiAssetPlanVersions, multiAssetRuns } = schema;

export type StoredMultiAssetPlan = typeof multiAssetPlanVersions.$inferSelect;
export type StoredMultiAssetRun = typeof multiAssetRuns.$inferSelect;

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

export async function listMultiAssetPlanVersions(limit = 50): Promise<StoredMultiAssetPlan[]> {
  return getDb().select().from(multiAssetPlanVersions)
    .orderBy(desc(multiAssetPlanVersions.createdAt)).limit(Math.max(1, Math.min(200, limit)));
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
    workerToken: null, leaseExpiresAt: null, attemptCount: 0,
    rebalancePlan: null, executionResult: null, resultHash: null,
    errorCode: null, errorMessage: null, createdAt: now,
    startedAt: null, completedAt: null, updatedAt: now,
  };
  try {
    await getDb().insert(multiAssetRuns).values(row);
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

export async function listMultiAssetRuns(planVersionId?: string, limit = 50): Promise<StoredMultiAssetRun[]> {
  const query = getDb().select().from(multiAssetRuns);
  return planVersionId
    ? query.where(eq(multiAssetRuns.planVersionId, planVersionId))
      .orderBy(desc(multiAssetRuns.createdAt)).limit(Math.max(1, Math.min(200, limit)))
    : query.orderBy(desc(multiAssetRuns.createdAt)).limit(Math.max(1, Math.min(200, limit)));
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
    startedAt: now, completedAt: null, updatedAt: now,
  }).where(and(eq(multiAssetRuns.id, id), eq(multiAssetRuns.status, 'queued')));
  if (affectedRows(result) !== 1) return null;
  return getMultiAssetRun(id);
}

export async function updateMultiAssetRunProgress(
  id: string,
  workerToken: string,
  progress: { stage: string; percent: number },
  leaseDurationMs: number,
): Promise<boolean> {
  return affectedRows(await getDb().update(multiAssetRuns).set({
    progress,
    leaseExpiresAt: new Date(Date.now() + leaseDurationMs).toISOString(),
    updatedAt: new Date().toISOString(),
  }).where(and(
    eq(multiAssetRuns.id, id),
    eq(multiAssetRuns.status, 'running'),
    eq(multiAssetRuns.workerToken, workerToken),
  ))) === 1;
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
  return affectedRows(await getDb().update(multiAssetRuns).set({
    status: 'completed', progress: { stage: 'completed', percent: 100 },
    rebalancePlan: input.rebalancePlan, executionResult: input.executionResult,
    resultHash: input.resultHash, errorCode: null, errorMessage: null,
    workerToken: null, leaseExpiresAt: null, completedAt: now, updatedAt: now,
  }).where(and(
    eq(multiAssetRuns.id, input.id),
    eq(multiAssetRuns.status, 'running'),
    eq(multiAssetRuns.workerToken, input.workerToken),
  ))) === 1;
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
