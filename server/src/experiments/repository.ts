import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import {
  buildSingleInstrumentSpec,
  canonicalHash,
  type ExperimentSpec,
} from './schema.js';

const {
  backtestResults,
  strategyExperiments,
  strategyExperimentVersions,
  strategyExperimentRuns,
  strategyExperimentEvents,
  strategyExperimentValidations,
  strategyExperimentValidationPlans,
} = schema;

const COMPILER_VERSION = 'single-instrument-dsl-1.0.0';

export interface ConfirmExperimentInput {
  experimentId?: string;
  name: string;
  sourceText: string;
  strategy: ExperimentSpec['signal']['document'];
  confirmation: unknown;
  capabilityVersion: string;
}

export async function confirmExperimentVersion(input: ConfirmExperimentInput) {
  const now = new Date().toISOString();
  const spec = buildSingleInstrumentSpec(input.strategy);
  const specHash = canonicalHash(spec);

  const [existing] = await getDb()
    .select()
    .from(strategyExperimentVersions)
    .where(eq(strategyExperimentVersions.specHash, specHash))
    .limit(1);
  if (existing) return { experimentVersion: existing, reused: true };

  const experimentId = input.experimentId ?? randomUUID();
  try {
    return await getDb().transaction(async (tx) => {
    const [experiment] = await tx
      .select()
      .from(strategyExperiments)
      .where(eq(strategyExperiments.id, experimentId))
      .limit(1);

    if (!experiment) {
      await tx.insert(strategyExperiments).values({
        id: experimentId,
        name: input.name,
        sourceText: input.sourceText,
        createdAt: now,
        updatedAt: now,
      });
    }

    const [latest] = await tx
      .select({ version: strategyExperimentVersions.version })
      .from(strategyExperimentVersions)
      .where(eq(strategyExperimentVersions.experimentId, experimentId))
      .orderBy(desc(strategyExperimentVersions.version))
      .limit(1);
    const version = (latest?.version ?? 0) + 1;
    const row = {
      id: randomUUID(),
      experimentId,
      version,
      status: 'frozen',
      spec,
      specHash,
      confirmation: input.confirmation,
      capabilityVersion: input.capabilityVersion,
      compilerVersion: COMPILER_VERSION,
      createdAt: now,
    };
    await tx.insert(strategyExperimentVersions).values(row);
    await tx.update(strategyExperiments)
      .set({ name: input.name, updatedAt: now })
      .where(eq(strategyExperiments.id, experimentId));
    return { experimentVersion: row, reused: false };
    });
  } catch (error) {
    const [raced] = await getDb()
      .select()
      .from(strategyExperimentVersions)
      .where(eq(strategyExperimentVersions.specHash, specHash))
      .limit(1);
    if (raced) return { experimentVersion: raced, reused: true };
    throw error;
  }
}

export interface CreateRunInput {
  experimentVersionId: string;
  idempotencyKey: string;
  engineVersion: string;
  datasetSnapshot: Record<string, unknown>;
  config: Record<string, unknown>;
  strategyParams: Record<string, number | boolean | string>;
}

export async function createExperimentRun(input: CreateRunInput) {
  const [version] = await getDb()
    .select()
    .from(strategyExperimentVersions)
    .where(eq(strategyExperimentVersions.id, input.experimentVersionId))
    .limit(1);
  if (!version) return null;

  const executionPlan = {
    schemaVersion: '1.0',
    runtime: 'browser_worker',
    engineVersion: input.engineVersion,
    compilerVersion: version.compilerVersion,
    datasetSnapshot: input.datasetSnapshot,
    config: input.config,
    strategyParams: input.strategyParams,
    timing: { signalAt: 'close', fillAt: 'next_open' },
  };
  const inputHash = canonicalHash({
    experimentVersionId: input.experimentVersionId,
    specHash: version.specHash,
    executionPlan,
  });

  const [validationPlan] = await getDb().select().from(strategyExperimentValidationPlans)
    .where(eq(strategyExperimentValidationPlans.experimentVersionId, input.experimentVersionId))
    .limit(1);
  if (validationPlan?.lockedTestStatus === 'opened') {
    const frozen = (validationPlan.samplePlan as {
      frozenBindings?: {
        strategyParamsHash?: string;
        configHash?: string;
        datasetSnapshotHash?: string;
      };
    }).frozenBindings;
    const bindingChecks = {
      strategyParams: frozen?.strategyParamsHash === canonicalHash(input.strategyParams),
      config: frozen?.configHash === canonicalHash(input.config),
      datasetSnapshot: frozen?.datasetSnapshotHash === canonicalHash(input.datasetSnapshot),
    };
    if (Object.values(bindingChecks).some((value) => !value)) {
      return { lockedConflict: true as const, conflict: false as const, bindingChecks, run: null };
    }
  }

  const [existing] = await getDb()
    .select()
    .from(strategyExperimentRuns)
    .where(eq(strategyExperimentRuns.idempotencyKey, input.idempotencyKey))
    .limit(1);
  if (existing) {
    if (existing.inputHash !== inputHash) {
      return { conflict: true as const, run: existing };
    }
    return { conflict: false as const, run: existing, reused: true };
  }

  const now = new Date().toISOString();
  const run = {
    id: randomUUID(),
    experimentVersionId: input.experimentVersionId,
    status: 'running',
    idempotencyKey: input.idempotencyKey,
    inputHash,
    executionPlan,
    backtestResultId: null,
    resultHash: null,
    errorCode: null,
    errorMessage: null,
    createdAt: now,
    startedAt: now,
    completedAt: null,
  };
  try {
    await getDb().transaction(async (tx) => {
      await tx.insert(strategyExperimentRuns).values(run);
      await tx.insert(strategyExperimentEvents).values({
        runId: run.id,
        eventType: 'run_started',
        payload: { inputHash, engineVersion: input.engineVersion },
        createdAt: now,
      });
    });
  } catch (error) {
    const [raced] = await getDb()
      .select()
      .from(strategyExperimentRuns)
      .where(eq(strategyExperimentRuns.idempotencyKey, input.idempotencyKey))
      .limit(1);
    if (!raced) throw error;
    if (raced.inputHash !== inputHash) return { conflict: true as const, run: raced };
    return { conflict: false as const, run: raced, reused: true };
  }
  return { conflict: false as const, run, reused: false };
}

export function canonicalBacktestResultHash(result: typeof backtestResults.$inferSelect): string {
  return canonicalHash({
    datasetSnapshot: result.datasetSnapshot,
    strategyId: result.strategyId,
    strategyVersion: result.strategyVersion,
    strategyParams: result.strategyParams,
    config: result.config,
    metrics: result.metrics,
    signals: result.signals,
    trades: result.trades,
    equityCurve: result.equityCurve,
  });
}

export async function completeExperimentRun(
  runId: string,
  input: {
    backtestResultId: string;
    resultHash: string;
    validation: Record<string, string>;
  },
) {
  const [run] = await getDb().select().from(strategyExperimentRuns)
    .where(eq(strategyExperimentRuns.id, runId)).limit(1);
  if (!run) return { type: 'not_found' as const };
  if (run.status === 'completed') return { type: 'completed' as const, run };
  if (run.status !== 'running') return { type: 'invalid_state' as const, run };

  const [result] = await getDb().select().from(backtestResults)
    .where(eq(backtestResults.id, input.backtestResultId)).limit(1);
  if (!result) return { type: 'result_not_found' as const };
  const [version] = await getDb().select().from(strategyExperimentVersions)
    .where(eq(strategyExperimentVersions.id, run.experimentVersionId)).limit(1);
  const plan = run.executionPlan as {
    datasetSnapshot?: unknown;
    config?: unknown;
    strategyParams?: unknown;
    timing?: unknown;
  };
  const spec = version?.spec as {
    signal?: { document?: { id?: string; strategyVersion?: number } };
    execution?: unknown;
  } | undefined;
  const bindingChecks = {
    strategyId: result.strategyId === spec?.signal?.document?.id,
    strategyVersion: result.strategyVersion === String(spec?.signal?.document?.strategyVersion),
    datasetSnapshot: canonicalHash(result.datasetSnapshot) === canonicalHash(plan.datasetSnapshot),
    config: canonicalHash(result.config) === canonicalHash(plan.config),
    strategyParams: canonicalHash(result.strategyParams) === canonicalHash(plan.strategyParams),
    executionTiming: canonicalHash(plan.timing) === canonicalHash(spec?.execution),
  };
  if (Object.values(bindingChecks).some((passed) => !passed)) {
    return { type: 'result_binding_mismatch' as const, bindingChecks };
  }
  const authoritativeHash = canonicalBacktestResultHash(result);
  if (authoritativeHash !== input.resultHash) {
    return { type: 'hash_mismatch' as const, authoritativeHash };
  }

  const now = new Date().toISOString();
  const transitioned = await getDb().transaction(async (tx) => {
    const updateResult = await tx.update(strategyExperimentRuns).set({
      status: 'completed',
      backtestResultId: input.backtestResultId,
      resultHash: authoritativeHash,
      completedAt: now,
    }).where(and(
      eq(strategyExperimentRuns.id, runId),
      eq(strategyExperimentRuns.status, 'running'),
    ));
    const header = Array.isArray(updateResult)
      ? updateResult[0] as { affectedRows?: number }
      : updateResult as unknown as { affectedRows?: number };
    if (Number(header?.affectedRows ?? 0) !== 1) return false;
    for (const [validationType, status] of Object.entries(input.validation)) {
      await tx.insert(strategyExperimentValidations).values({
        id: randomUUID(),
        runId,
        validationType,
        status: status === 'passed' || status === 'close_to_next_open' ? 'passed' : 'failed',
        details: { value: status },
        createdAt: now,
      }).onDuplicateKeyUpdate({
        set: { status: 'passed', details: { value: status }, createdAt: now },
      });
    }
    await tx.insert(strategyExperimentEvents).values({
      runId,
      eventType: 'run_completed',
      payload: { backtestResultId: input.backtestResultId, resultHash: authoritativeHash },
      createdAt: now,
    });
    return true;
  });
  const [completed] = await getDb().select().from(strategyExperimentRuns)
    .where(eq(strategyExperimentRuns.id, runId)).limit(1);
  if (!transitioned) return { type: 'invalid_state' as const, run: completed };
  return { type: 'completed' as const, run: completed };
}

export async function finishExperimentRun(
  runId: string,
  status: 'cancelled' | 'failed',
  error?: { code: string; message: string },
) {
  const [run] = await getDb().select().from(strategyExperimentRuns)
    .where(eq(strategyExperimentRuns.id, runId)).limit(1);
  if (!run) return null;
  if (run.status !== 'running') return run;
  const now = new Date().toISOString();
  await getDb().transaction(async (tx) => {
    const updateResult = await tx.update(strategyExperimentRuns).set({
      status,
      errorCode: error?.code ?? null,
      errorMessage: error?.message ?? null,
      completedAt: now,
    }).where(and(
      eq(strategyExperimentRuns.id, runId),
      eq(strategyExperimentRuns.status, 'running'),
    ));
    const header = Array.isArray(updateResult)
      ? updateResult[0] as { affectedRows?: number }
      : updateResult as unknown as { affectedRows?: number };
    if (Number(header?.affectedRows ?? 0) !== 1) return;
    await tx.insert(strategyExperimentEvents).values({
      runId,
      eventType: status === 'cancelled' ? 'run_cancelled' : 'run_failed',
      payload: error ?? {},
      createdAt: now,
    });
  });
  const [updated] = await getDb().select().from(strategyExperimentRuns)
    .where(eq(strategyExperimentRuns.id, runId)).limit(1);
  return updated;
}

export async function getExperimentRun(id: string) {
  const [run] = await getDb().select().from(strategyExperimentRuns)
    .where(eq(strategyExperimentRuns.id, id)).limit(1);
  if (!run) return null;
  const events = await getDb().select().from(strategyExperimentEvents)
    .where(eq(strategyExperimentEvents.runId, id))
    .orderBy(strategyExperimentEvents.createdAt);
  const validations = await getDb().select().from(strategyExperimentValidations)
    .where(eq(strategyExperimentValidations.runId, id));
  return { ...run, events, validations };
}

export async function listExperimentRuns(limit = 50) {
  return getDb().select().from(strategyExperimentRuns)
    .orderBy(desc(strategyExperimentRuns.createdAt))
    .limit(Math.min(200, Math.max(1, limit)));
}

export async function listExperimentVersions(limit = 50) {
  return getDb().select({
    id: strategyExperimentVersions.id,
    experimentId: strategyExperimentVersions.experimentId,
    version: strategyExperimentVersions.version,
    status: strategyExperimentVersions.status,
    specHash: strategyExperimentVersions.specHash,
    capabilityVersion: strategyExperimentVersions.capabilityVersion,
    compilerVersion: strategyExperimentVersions.compilerVersion,
    createdAt: strategyExperimentVersions.createdAt,
  }).from(strategyExperimentVersions)
    .orderBy(desc(strategyExperimentVersions.createdAt))
    .limit(Math.min(200, Math.max(1, limit)));
}

export async function getExperimentVersion(id: string) {
  const [version] = await getDb().select().from(strategyExperimentVersions)
    .where(eq(strategyExperimentVersions.id, id)).limit(1);
  return version ?? null;
}
