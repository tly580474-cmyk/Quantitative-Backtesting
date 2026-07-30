import { createHash, randomUUID } from 'node:crypto';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { getDb, schema } from '../../db/index.js';
import { validateAndAnalyzeFactorAst } from '../definitions/factorAst.js';
import type { AstFactorExpression, FactorDefinition, FactorDirection } from '../definitions/schema.js';
import { assertCandidateTransition, type FactorCandidateStatus } from './candidateState.js';
import { evaluateCandidateReleaseGate } from './candidateGate.js';
import { buildCandidateSignatures } from './candidateSignature.js';

const FAMILY_FAILURE_THRESHOLD = 3;

export class CandidateSuppressedError extends Error {
  constructor(public readonly suppressionReason: 'exact_duplicate' | 'invalid_family') {
    super(suppressionReason === 'exact_duplicate'
      ? '该候选公式及方向已经被挖掘过'
      : `该候选方向族已累计验证失败至少 ${FAMILY_FAILURE_THRESHOLD} 次`);
    this.name = 'CandidateSuppressedError';
  }
}

export interface CreateMiningTaskInput {
  snapshotId: string;
  config: Record<string, unknown>;
  lineage: Record<string, unknown>;
  totalGenerations: number;
  artifactUri?: string;
}

export interface CreateFactorCandidateInput {
  taskId: string;
  name: string;
  formula: string;
  expression: AstFactorExpression;
  direction: FactorDirection;
  validationMetrics: Record<string, unknown>;
  sourceLineage: Record<string, unknown>;
}

export async function createMiningTask(input: CreateMiningTaskInput) {
  const now = new Date().toISOString();
  const task = {
    id: randomUUID(), status: 'pending', snapshotId: input.snapshotId,
    config: input.config, lineage: input.lineage,
    totalGenerations: input.totalGenerations, completedGenerations: 0,
    artifactUri: input.artifactUri ?? null, errorMessage: null,
    createdAt: now, startedAt: null, finishedAt: null,
    workerPid: null, archivedAt: null, deletedAt: null,
  };
  await getDb().insert(schema.factorMiningTasks).values(task);
  return task;
}

export async function getMiningTask(id: string) {
  const [task] = await getDb().select().from(schema.factorMiningTasks)
    .where(and(eq(schema.factorMiningTasks.id, id), isNull(schema.factorMiningTasks.deletedAt))).limit(1);
  return task ?? null;
}

export async function listMiningTasks(limit = 20, includeArchived = false) {
  return getDb().select().from(schema.factorMiningTasks)
    .where(and(
      isNull(schema.factorMiningTasks.deletedAt),
      includeArchived ? undefined : isNull(schema.factorMiningTasks.archivedAt),
    ))
    .orderBy(desc(schema.factorMiningTasks.createdAt)).limit(Math.min(Math.max(limit, 1), 100));
}

const terminalMiningTaskStatuses = new Set(['completed', 'failed', 'canceled']);

export function canManageMiningTask(status: string): boolean {
  return terminalMiningTaskStatuses.has(status);
}

export async function archiveMiningTask(id: string, archived: boolean) {
  const task = await getMiningTask(id);
  if (!task) return null;
  if (!canManageMiningTask(task.status)) throw new Error('只有已取消、失败或已完成的任务可以归档');
  await getDb().update(schema.factorMiningTasks)
    .set({ archivedAt: archived ? new Date().toISOString() : null })
    .where(and(eq(schema.factorMiningTasks.id, id), isNull(schema.factorMiningTasks.deletedAt)));
  return getMiningTask(id);
}

export async function deleteMiningTask(id: string) {
  const task = await getMiningTask(id);
  if (!task) return null;
  if (!canManageMiningTask(task.status)) throw new Error('只有已取消、失败或已完成的任务可以删除');
  await getDb().update(schema.factorMiningTasks)
    .set({ deletedAt: new Date().toISOString() })
    .where(and(eq(schema.factorMiningTasks.id, id), isNull(schema.factorMiningTasks.deletedAt)));
  return task;
}

export async function updateMiningTask(id: string, update: {
  status?: string; completedGenerations?: number; artifactUri?: string | null;
  errorMessage?: string | null; startedAt?: string | null; finishedAt?: string | null;
  workerPid?: number | null;
}) {
  await getDb().update(schema.factorMiningTasks).set(update)
    .where(eq(schema.factorMiningTasks.id, id));
  return getMiningTask(id);
}

export async function updateMiningTaskProgress(id: string, completedGenerations: number) {
  const completed = Math.max(0, Math.trunc(completedGenerations));
  await getDb().update(schema.factorMiningTasks).set({
    completedGenerations: sql`GREATEST(${schema.factorMiningTasks.completedGenerations}, ${completed})`,
  }).where(and(
    eq(schema.factorMiningTasks.id, id),
    eq(schema.factorMiningTasks.status, 'running'),
  ));
}

export async function listRunningMiningTasks() {
  return getDb().select().from(schema.factorMiningTasks)
    .where(and(
      eq(schema.factorMiningTasks.status, 'running'),
      isNull(schema.factorMiningTasks.deletedAt),
    ));
}

export async function createMiningSchedule(input: {
  name: string; config: Record<string, unknown>; totalGenerations: number;
  lastSnapshotId: string; lastTestEndDate: string;
}) {
  const now = new Date().toISOString();
  const schedule = { id: randomUUID(), name: input.name.trim(), enabled: 1,
    config: input.config, totalGenerations: input.totalGenerations,
    lastSnapshotId: input.lastSnapshotId, lastTestEndDate: input.lastTestEndDate,
    lastTaskId: null, createdAt: now, updatedAt: now };
  if (!schedule.name) throw new Error('调度名称不能为空');
  await getDb().insert(schema.factorMiningSchedules).values(schedule);
  return schedule;
}

export async function listMiningSchedules(enabledOnly = false) {
  return getDb().select().from(schema.factorMiningSchedules)
    .where(enabledOnly ? eq(schema.factorMiningSchedules.enabled, 1) : undefined)
    .orderBy(desc(schema.factorMiningSchedules.updatedAt));
}

export async function updateMiningSchedule(id: string, update: {
  enabled?: number; lastSnapshotId?: string | null; lastTestEndDate?: string | null;
  lastTaskId?: string | null;
}) {
  await getDb().update(schema.factorMiningSchedules).set({ ...update, updatedAt: new Date().toISOString() })
    .where(eq(schema.factorMiningSchedules.id, id));
}

export async function createFactorCandidate(input: CreateFactorCandidateInput) {
  if (input.expression.type !== 'ast' || input.expression.version !== 1) {
    throw new Error('候选因子必须使用 AST v1');
  }
  const analysis = validateAndAnalyzeFactorAst(input.expression.root);
  const now = new Date().toISOString();
  const signatures = buildCandidateSignatures(input.expression, input.direction);
  const suppression = await registerCandidateDiscovery(signatures, input.direction, now);
  if (suppression) throw new CandidateSuppressedError(suppression);
  const candidate = {
    id: randomUUID(), taskId: input.taskId, name: input.name.trim(), formula: input.formula,
    expression: input.expression, direction: input.direction,
    dependencies: analysis.dependencies, warmupDays: analysis.warmupDays,
    status: 'draft', validationMetrics: input.validationMetrics,
    lockedTestMetrics: null, sourceLineage: input.sourceLineage, factorRunId: null,
    publishedFactorVersionId: null,
    rejectionReason: null, approvedBy: null, approvedAt: null,
    createdAt: now, updatedAt: now,
  };
  if (!candidate.name) throw new Error('候选因子名称不能为空');
  await getDb().insert(schema.factorCandidates).values(candidate);
  return candidate;
}

async function registerCandidateDiscovery(
  signatures: { signature: string; familySignature: string },
  direction: FactorDirection,
  now: string,
): Promise<'exact_duplicate' | 'invalid_family' | null> {
  const [exact] = await getDb().select({
    signature: schema.factorSearchFeedback.signature,
  }).from(schema.factorSearchFeedback)
    .where(eq(schema.factorSearchFeedback.signature, signatures.signature))
    .limit(1);
  if (exact) {
    await getDb().update(schema.factorSearchFeedback).set({
      seenCount: sql`${schema.factorSearchFeedback.seenCount} + 1`,
      updatedAt: now,
    }).where(eq(schema.factorSearchFeedback.signature, signatures.signature));
    return 'exact_duplicate';
  }

  const family = await getDb().select({
    failureCount: schema.factorSearchFeedback.failureCount,
    successCount: schema.factorSearchFeedback.successCount,
  }).from(schema.factorSearchFeedback)
    .where(eq(schema.factorSearchFeedback.familySignature, signatures.familySignature));
  const failures = family.reduce((sum, row) => sum + row.failureCount, 0);
  const successes = family.reduce((sum, row) => sum + row.successCount, 0);
  const invalidFamily = failures >= FAMILY_FAILURE_THRESHOLD && successes === 0;

  try {
    await getDb().insert(schema.factorSearchFeedback).values({
      signature: signatures.signature,
      familySignature: signatures.familySignature,
      direction,
      seenCount: 1,
      failureCount: 0,
      successCount: 0,
      lastCandidateId: null,
      lastReason: invalidFamily ? '命中跨任务无效方向过滤器' : null,
      firstSeenAt: now,
      updatedAt: now,
    });
  } catch (error) {
    if ((error as { code?: string }).code === 'ER_DUP_ENTRY') return 'exact_duplicate';
    throw error;
  }
  return invalidFamily ? 'invalid_family' : null;
}

async function recordCandidateOutcome(
  candidate: NonNullable<Awaited<ReturnType<typeof getFactorCandidate>>>,
  outcome: 'invalid' | 'valid',
  reason: string,
): Promise<void> {
  const expression = candidate.expression as AstFactorExpression;
  const direction = candidate.direction as FactorDirection;
  const signatures = buildCandidateSignatures(expression, direction);
  const now = new Date().toISOString();
  await getDb().insert(schema.factorSearchFeedback).values({
    signature: signatures.signature,
    familySignature: signatures.familySignature,
    direction,
    seenCount: 1,
    failureCount: outcome === 'invalid' ? 1 : 0,
    successCount: outcome === 'valid' ? 1 : 0,
    lastCandidateId: candidate.id,
    lastReason: reason.slice(0, 1000),
    firstSeenAt: now,
    updatedAt: now,
  }).onDuplicateKeyUpdate({
    set: {
      failureCount: outcome === 'invalid'
        ? sql`GREATEST(${schema.factorSearchFeedback.failureCount}, 1)`
        : sql`${schema.factorSearchFeedback.failureCount}`,
      successCount: outcome === 'valid'
        ? sql`GREATEST(${schema.factorSearchFeedback.successCount}, 1)`
        : sql`${schema.factorSearchFeedback.successCount}`,
      lastCandidateId: candidate.id,
      lastReason: reason.slice(0, 1000),
      updatedAt: now,
    },
  });
}

export async function listBlockedCandidateFamilySignatures(): Promise<string[]> {
  const rows = await getDb().select({
    familySignature: schema.factorSearchFeedback.familySignature,
    failureCount: schema.factorSearchFeedback.failureCount,
    successCount: schema.factorSearchFeedback.successCount,
  }).from(schema.factorSearchFeedback);
  const families = new Map<string, { failures: number; successes: number }>();
  for (const row of rows) {
    const current = families.get(row.familySignature) ?? { failures: 0, successes: 0 };
    current.failures += row.failureCount;
    current.successes += row.successCount;
    families.set(row.familySignature, current);
  }
  return [...families.entries()]
    .filter(([, value]) => value.failures >= FAMILY_FAILURE_THRESHOLD && value.successes === 0)
    .map(([signature]) => signature);
}

export async function listFactorCandidates(taskId?: string, status?: FactorCandidateStatus) {
  const conditions = [
    taskId ? eq(schema.factorCandidates.taskId, taskId) : undefined,
    status ? eq(schema.factorCandidates.status, status) : undefined,
  ].filter((item): item is NonNullable<typeof item> => Boolean(item));
  return getDb().select().from(schema.factorCandidates)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(schema.factorCandidates.updatedAt));
}

export async function getFactorCandidate(id: string) {
  const [candidate] = await getDb().select().from(schema.factorCandidates)
    .where(eq(schema.factorCandidates.id, id)).limit(1);
  return candidate ?? null;
}

export async function recordCandidateAutoGateResult(
  id: string,
  result: { passed: boolean; failures: string[] },
) {
  const candidate = await getFactorCandidate(id);
  if (!candidate || candidate.status !== 'tested') return null;
  const metrics = candidate.lockedTestMetrics && typeof candidate.lockedTestMetrics === 'object'
    ? candidate.lockedTestMetrics as Record<string, unknown> : {};
  const updatedAt = new Date().toISOString();
  const updateResult = await getDb().update(schema.factorCandidates).set({
    lockedTestMetrics: {
      ...metrics,
      autoGate: {
        version: 2,
        passed: result.passed,
        failures: result.failures,
        evaluatedAt: updatedAt,
      },
    },
    updatedAt,
  }).where(and(
    eq(schema.factorCandidates.id, id),
    eq(schema.factorCandidates.status, 'tested'),
  ));
  const header = Array.isArray(updateResult) ? updateResult[0] as { affectedRows?: number }
    : updateResult as unknown as { affectedRows?: number };
  return Number(header?.affectedRows ?? 0) === 1 ? getFactorCandidate(id) : null;
}

/** 单实例服务重启后，内存中的后台锁定测试已不存在，允许用户安全地重新执行。 */
export async function recoverInterruptedCandidateTests(): Promise<number> {
  const result = await getDb().update(schema.factorCandidates).set({
    status: 'frozen',
    rejectionReason: '上次锁定测试因服务重启中断，请重新执行',
    updatedAt: new Date().toISOString(),
  }).where(eq(schema.factorCandidates.status, 'testing'));
  const header = Array.isArray(result) ? result[0] as { affectedRows?: number }
    : result as unknown as { affectedRows?: number };
  return Number(header?.affectedRows ?? 0);
}

export async function transitionFactorCandidate(
  id: string,
  to: FactorCandidateStatus,
  context: { lockedTestMetrics?: Record<string, unknown>; factorRunId?: string;
    approvedBy?: string; rejectionReason?: string },
) {
  const candidate = await getFactorCandidate(id);
  if (!candidate) return null;
  const from = candidate.status as FactorCandidateStatus;
  if (to === 'approved') {
    const gate = evaluateCandidateReleaseGate(candidate.lockedTestMetrics, candidate.validationMetrics);
    if (!gate.passed) {
      const reason = `候选未通过发布硬门槛：${gate.failures.join('；')}`;
      await recordCandidateOutcome(candidate, 'invalid', reason);
      throw new Error(reason);
    }
  }
  assertCandidateTransition(from, to, context);
  const now = new Date().toISOString();
  const result = await getDb().update(schema.factorCandidates).set({
    status: to,
    lockedTestMetrics: to === 'tested' ? context.lockedTestMetrics : candidate.lockedTestMetrics,
    factorRunId: to === 'tested' ? context.factorRunId ?? null : candidate.factorRunId,
    rejectionReason: to === 'rejected' ? context.rejectionReason
      : to === 'testing' ? null : candidate.rejectionReason,
    approvedBy: to === 'approved' ? context.approvedBy : candidate.approvedBy,
    approvedAt: to === 'approved' ? now : candidate.approvedAt,
    updatedAt: now,
  }).where(and(eq(schema.factorCandidates.id, id), eq(schema.factorCandidates.status, from)));
  const header = Array.isArray(result) ? result[0] as { affectedRows?: number }
    : result as unknown as { affectedRows?: number };
  if (Number(header?.affectedRows ?? 0) !== 1) {
    throw new Error('候选状态已被其他操作更新，请刷新后重试');
  }
  const updated = await getFactorCandidate(id);
  if (updated && to === 'rejected') {
    await recordCandidateOutcome(updated, 'invalid', context.rejectionReason ?? '候选被拒绝');
  }
  if (updated && to === 'approved') {
    await recordCandidateOutcome(updated, 'valid', `由 ${context.approvedBy} 批准`);
  }
  return updated;
}

export function candidateToFactorDefinition(candidate: Awaited<ReturnType<typeof getFactorCandidate>>): FactorDefinition {
  if (!candidate) throw new Error('候选因子不存在');
  return {
    id: `candidate_${candidate.id.replaceAll('-', '')}`,
    name: candidate.name,
    description: `自动挖掘候选：${candidate.formula}`.slice(0, 1000),
    direction: candidate.direction as FactorDirection,
    dependencies: candidate.dependencies as FactorDefinition['dependencies'],
    warmupDays: candidate.warmupDays,
    expression: candidate.expression as AstFactorExpression,
  };
}

export async function publishApprovedCandidate(id: string) {
  const candidate = await getFactorCandidate(id);
  if (!candidate) return null;
  if (candidate.status !== 'approved') throw new Error('只有 approved 候选可以发布正式因子版本');
  if (candidate.publishedFactorVersionId) {
    return { candidate, factorId: candidate.publishedFactorVersionId.split(':v')[0],
      versionId: candidate.publishedFactorVersionId, alreadyPublished: true };
  }
  const definition = candidateToFactorDefinition(candidate);
  const now = new Date().toISOString();
  const versionId = `${definition.id}:v1`;
  const checksum = createHash('sha256').update(JSON.stringify({
    direction: definition.direction, dependencies: definition.dependencies,
    warmupDays: definition.warmupDays, expression: definition.expression,
  })).digest('hex');
  const db = getDb();
  await db.transaction(async (tx) => {
    await tx.insert(schema.factorDefinitions).values({
      id: definition.id, name: definition.name, description: definition.description,
      status: 'active', createdAt: now, updatedAt: now,
    });
    await tx.insert(schema.factorVersions).values({
      id: versionId, factorId: definition.id, version: 1,
      expression: definition.expression, direction: definition.direction,
      dependencies: definition.dependencies, warmupDays: definition.warmupDays,
      checksum, publishedAt: now,
    });
    await tx.update(schema.factorCandidates).set({
      publishedFactorVersionId: versionId, updatedAt: now,
    }).where(and(eq(schema.factorCandidates.id, id), eq(schema.factorCandidates.status, 'approved')));
  });
  return { candidate: await getFactorCandidate(id), factorId: definition.id,
    versionId, alreadyPublished: false };
}
