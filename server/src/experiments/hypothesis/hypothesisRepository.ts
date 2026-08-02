import { randomUUID } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import { getDb, schema } from '../../db/index.js';
import {
  hypothesisRecordSchema,
  hypothesisStatusSchema,
  type HypothesisEvaluationSummary,
  type HypothesisPlan,
  type HypothesisRecord,
  type HypothesisStatus,
} from './hypothesisSchema.js';

// N3.4 后端支撑：假设持久化与状态机。
// 状态机：draft → evaluated（M2 评估完成）| rejected（人工否决）。
// evaluated/rejected 为终态，不可再次转移。

const { strategyHypotheses } = schema;

function serialize(row: typeof strategyHypotheses.$inferSelect): HypothesisRecord {
  return hypothesisRecordSchema.parse({
    id: row.id,
    plan: {
      protocolVersion: '1.0',
      strategyType: row.strategyType,
      params: row.params,
      name: row.name,
      description: row.description,
      rationale: row.rationale,
      capabilityVersion: row.sourceCapabilityVersion,
    },
    status: row.status,
    mappedExperimentVersionId: row.mappedExperimentVersionId ?? null,
    lastRunId: row.lastRunId ?? null,
    validationStatus: row.validationStatus ?? null,
    evaluationSummary: row.evaluationSummary ?? null,
    rejectionReason: row.rejectionReason ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

export async function createHypotheses(input: {
  plans: HypothesisPlan[];
  capabilityVersion: string;
}): Promise<HypothesisRecord[]> {
  const now = new Date().toISOString();
  const rows = input.plans.map((plan) => ({
    id: randomUUID(),
    name: plan.name,
    description: plan.description,
    status: 'draft' as const,
    strategyType: plan.strategyType,
    params: plan.params,
    rationale: plan.rationale,
    sourceCapabilityVersion: plan.capabilityVersion || input.capabilityVersion,
    mappedExperimentVersionId: null,
    lastRunId: null,
    validationStatus: null,
    evaluationSummary: null,
    rejectionReason: null,
    createdAt: now,
    updatedAt: now,
  }));
  if (rows.length > 0) {
    await getDb().insert(strategyHypotheses).values(rows);
  }
  return rows.map((row) => serialize(row));
}

export async function listHypotheses(limit = 100): Promise<HypothesisRecord[]> {
  const rows = await getDb().select().from(strategyHypotheses)
    .orderBy(desc(strategyHypotheses.createdAt))
    .limit(Math.min(500, Math.max(1, limit)));
  return rows.map(serialize);
}

export async function getHypothesis(id: string): Promise<HypothesisRecord | null> {
  const [row] = await getDb().select().from(strategyHypotheses)
    .where(eq(strategyHypotheses.id, id)).limit(1);
  return row ? serialize(row) : null;
}

export async function assertHypothesisDraft(id: string): Promise<HypothesisRecord> {
  const hypothesis = await getHypothesis(id);
  if (!hypothesis) throw new Error('HYPOTHESIS_NOT_FOUND');
  if (hypothesis.status !== 'draft') {
    throw new Error(`HYPOTHESIS_INVALID_STATE:${hypothesis.status}`);
  }
  return hypothesis;
}

export async function markHypothesisEvaluated(input: {
  id: string;
  mappedExperimentVersionId: string;
  lastRunId: string;
  validationStatus: HypothesisRecord['validationStatus'];
  evaluationSummary: HypothesisEvaluationSummary;
}): Promise<HypothesisRecord> {
  const now = new Date().toISOString();
  await getDb().update(strategyHypotheses).set({
    status: 'evaluated',
    mappedExperimentVersionId: input.mappedExperimentVersionId,
    lastRunId: input.lastRunId,
    validationStatus: input.validationStatus,
    evaluationSummary: input.evaluationSummary,
    updatedAt: now,
  }).where(eq(strategyHypotheses.id, input.id));
  const updated = await getHypothesis(input.id);
  if (!updated) throw new Error('HYPOTHESIS_NOT_FOUND');
  return updated;
}

export async function rejectHypothesis(id: string, reason: string): Promise<HypothesisRecord> {
  const hypothesis = await assertHypothesisDraft(id);
  const now = new Date().toISOString();
  await getDb().update(strategyHypotheses).set({
    status: 'rejected',
    rejectionReason: reason.slice(0, 1000),
    updatedAt: now,
  }).where(eq(strategyHypotheses.id, id));
  const updated = await getHypothesis(id);
  if (!updated) throw new Error('HYPOTHESIS_NOT_FOUND');
  return updated;
}

export function isTerminalHypothesisStatus(status: HypothesisStatus): boolean {
  return status !== 'draft';
}

export { hypothesisStatusSchema };
