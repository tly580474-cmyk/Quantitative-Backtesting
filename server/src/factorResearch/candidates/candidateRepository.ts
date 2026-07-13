import { createHash, randomUUID } from 'node:crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { getDb, schema } from '../../db/index.js';
import { validateAndAnalyzeFactorAst } from '../definitions/factorAst.js';
import type { AstFactorExpression, FactorDefinition, FactorDirection } from '../definitions/schema.js';
import { assertCandidateTransition, type FactorCandidateStatus } from './candidateState.js';
import { evaluateCandidateReleaseGate } from './candidateGate.js';

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
    if (!gate.passed) throw new Error(`候选未通过发布硬门槛：${gate.failures.join('；')}`);
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
  return getFactorCandidate(id);
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
