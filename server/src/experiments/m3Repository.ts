import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { and, asc, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { canonicalHash } from './schema.js';
import {
  buildPerturbationPlan,
  buildSampleIsolationPlan,
  DEFAULT_SAMPLE_PLAN,
  DEFAULT_VALIDATION_POLICY,
  DEFAULT_VALIDATION_POLICY_VERSION,
  evaluateDeterministicGate,
  VALIDATION_CALCULATOR_VERSION,
  validateDynamicCausality,
  validateStaticCausality,
} from './validation.js';
import {
  buildStructuredReport,
  EXPERIMENT_REPORT_TEMPLATE_VERSION,
  renderExperimentMarkdown,
  reportHash,
} from './report.js';
import { claimAtomicGate } from './atomicGate.js';
import {
  describeReportArtifact,
  isArtifactPathInsideRoot,
  renderReportArtifact,
} from './reportArtifacts.js';

const {
  backtestResults,
  strategyExperimentRuns,
  strategyExperimentVersions,
  strategyExperimentEvents,
  strategyExperimentValidations,
  strategyExperimentValidationPolicies,
  strategyExperimentValidationPlans,
  strategyExperimentGateEvaluations,
  strategyExperimentReports,
  strategyExperimentArtifactJobs,
  strategyExperiments,
  strategyExperimentReportWorkers,
} = schema;

function affectedRows(result: unknown): number {
  const header = Array.isArray(result) ? result[0] : result;
  return Number((header as { affectedRows?: number } | undefined)?.affectedRows ?? 0);
}

export async function ensureDefaultValidationPolicy() {
  const [existing] = await getDb().select().from(strategyExperimentValidationPolicies)
    .where(eq(strategyExperimentValidationPolicies.version, DEFAULT_VALIDATION_POLICY_VERSION)).limit(1);
  if (existing) return existing;
  const row = {
    id: randomUUID(), version: DEFAULT_VALIDATION_POLICY_VERSION, status: 'active',
    config: DEFAULT_VALIDATION_POLICY, configHash: canonicalHash(DEFAULT_VALIDATION_POLICY),
    createdAt: new Date().toISOString(),
  };
  try {
    await getDb().insert(strategyExperimentValidationPolicies).values(row);
    return row;
  } catch (error) {
    const [raced] = await getDb().select().from(strategyExperimentValidationPolicies)
      .where(eq(strategyExperimentValidationPolicies.version, DEFAULT_VALIDATION_POLICY_VERSION)).limit(1);
    if (raced) return raced;
    throw error;
  }
}

async function ensureValidationPlan(
  version: typeof strategyExperimentVersions.$inferSelect,
  result: typeof backtestResults.$inferSelect,
) {
  const [existing] = await getDb().select().from(strategyExperimentValidationPlans)
    .where(eq(strategyExperimentValidationPlans.experimentVersionId, version.id)).limit(1);
  if (existing) return existing;
  const policy = await ensureDefaultValidationPolicy();
  const equity = Array.isArray(result.equityCurve) ? result.equityCurve as Array<{ time?: unknown }> : [];
  const times = equity.map((point) => String(point.time ?? '')).filter(Boolean);
  const samplePlan = {
    ...buildSampleIsolationPlan(times, DEFAULT_SAMPLE_PLAN),
    frozenBindings: {
      strategyParamsHash: canonicalHash(result.strategyParams),
      configHash: canonicalHash(result.config),
      datasetSnapshotHash: canonicalHash(result.datasetSnapshot),
    },
  };
  const perturbationPlan = buildPerturbationPlan(result.strategyParams as Record<string, unknown>);
  const planHash = canonicalHash({
    experimentVersionId: version.id, policyVersion: policy.version, samplePlan, perturbationPlan,
  });
  const now = new Date().toISOString();
  const row = {
    id: randomUUID(), experimentVersionId: version.id, policyId: policy.id,
    samplePlan, perturbationPlan, planHash, lockedTestStatus: 'sealed',
    lockedTestOpenedAt: null, lockedTestOpenToken: null, createdAt: now, updatedAt: now,
  };
  try {
    await getDb().insert(strategyExperimentValidationPlans).values(row);
    return row;
  } catch (error) {
    const [raced] = await getDb().select().from(strategyExperimentValidationPlans)
      .where(eq(strategyExperimentValidationPlans.experimentVersionId, version.id)).limit(1);
    if (raced) return raced;
    throw error;
  }
}

export async function openLockedTest(experimentVersionId: string, idempotencyKey: string) {
  const [plan] = await getDb().select().from(strategyExperimentValidationPlans)
    .where(eq(strategyExperimentValidationPlans.experimentVersionId, experimentVersionId)).limit(1);
  if (!plan) return { type: 'plan_not_found' as const };
  const token = canonicalHash({ experimentVersionId, idempotencyKey, planHash: plan.planHash });
  const now = new Date().toISOString();
  const claimed = await claimAtomicGate({
    read: async () => {
      const [current] = await getDb().select().from(strategyExperimentValidationPlans)
        .where(eq(strategyExperimentValidationPlans.id, plan.id)).limit(1);
      return {
        status: current.lockedTestStatus as 'sealed' | 'opened',
        token: current.lockedTestOpenToken,
        value: current,
      };
    },
    compareAndSet: async (requestedToken) => affectedRows(
      await getDb().update(strategyExperimentValidationPlans).set({
        lockedTestStatus: 'opened', lockedTestOpenedAt: now,
        lockedTestOpenToken: requestedToken, updatedAt: now,
      }).where(and(
        eq(strategyExperimentValidationPlans.id, plan.id),
        eq(strategyExperimentValidationPlans.lockedTestStatus, 'sealed'),
      )),
    ) === 1,
  }, token);
  return claimed.type === 'opened'
    ? { type: 'opened' as const, plan: claimed.value, reused: claimed.reused }
    : { type: 'already_opened' as const, plan: claimed.value };
}

export interface PerturbationObservation {
  caseId: string;
  totalReturn: number;
}

export async function validateCompletedExperimentRun(
  runId: string,
  perturbations: PerturbationObservation[] = [],
  sampleResults?: {
    train?: { totalReturn: number };
    validation?: { totalReturn: number };
    lockedTest?: { totalReturn: number };
    walkForward?: Array<{ totalReturn: number }>;
  },
) {
  const [run] = await getDb().select().from(strategyExperimentRuns)
    .where(eq(strategyExperimentRuns.id, runId)).limit(1);
  if (!run) return { type: 'run_not_found' as const };
  if (run.status !== 'completed' || !run.backtestResultId || !run.resultHash) {
    return { type: 'invalid_state' as const, run };
  }
  const [version] = await getDb().select().from(strategyExperimentVersions)
    .where(eq(strategyExperimentVersions.id, run.experimentVersionId)).limit(1);
  const [result] = await getDb().select().from(backtestResults)
    .where(eq(backtestResults.id, run.backtestResultId)).limit(1);
  if (!version || !result) return { type: 'binding_not_found' as const };
  const plan = await ensureValidationPlan(version, result);
  const policy = await ensureDefaultValidationPolicy();
  const policyConfig = policy.config as typeof DEFAULT_VALIDATION_POLICY;
  const spec = version.spec;
  const snapshot = result.datasetSnapshot as { startTime?: unknown; endTime?: unknown };
  const staticChecks = validateStaticCausality(spec);
  const dynamicChecks = validateDynamicCausality(
    result.signals, result.trades, String(snapshot.startTime ?? ''), String(snapshot.endTime ?? ''),
  );
  const baseReturn = Number((result.metrics as Record<string, unknown>).totalReturn);
  const expectedCases = (plan.perturbationPlan as Array<{ id?: unknown }>).map((item) => String(item.id));
  const observationsByCase = new Map(perturbations.map((item) => [item.caseId, item]));
  const acceptedPerturbations = expectedCases.flatMap((id) => {
    const observation = observationsByCase.get(id);
    return observation ? [observation] : [];
  });
  const worstDecay = acceptedPerturbations.length > 0 && Number.isFinite(baseReturn) && Math.abs(baseReturn) > 1e-12
    ? Math.max(...acceptedPerturbations.map((item) => (baseReturn - item.totalReturn) / Math.abs(baseReturn)))
    : null;
  const evaluation = evaluateDeterministicGate({
    metrics: result.metrics as Record<string, unknown>,
    lockedTestOpened: plan.lockedTestStatus === 'opened',
    staticChecks, dynamicChecks, policy: policyConfig, perturbationWorstDecay: worstDecay,
    perturbationExpectedCases: expectedCases.length,
    perturbationObservedCases: acceptedPerturbations.length,
    sampleResults,
  });
  const now = new Date().toISOString();
  const runEvaluationHash = canonicalHash({
    runId,
    resultHash: run.resultHash,
    calculatorVersion: VALIDATION_CALCULATOR_VERSION,
    gateEvaluationHash: evaluation.evaluationHash,
  });
  const evaluationRow = {
    id: randomUUID(), runId, policyId: policy.id, status: evaluation.status,
    checks: evaluation.checks, metricsSnapshot: result.metrics,
    calculatorVersion: VALIDATION_CALCULATOR_VERSION,
    evaluationHash: runEvaluationHash, createdAt: now,
  };
  await getDb().transaction(async (tx) => {
    await tx.insert(strategyExperimentGateEvaluations).values(evaluationRow).onDuplicateKeyUpdate({
      set: {
        status: evaluationRow.status, checks: evaluationRow.checks,
        metricsSnapshot: evaluationRow.metricsSnapshot,
        calculatorVersion: evaluationRow.calculatorVersion,
        evaluationHash: evaluationRow.evaluationHash, createdAt: now,
      },
    });
    for (const check of evaluation.checks) {
      await tx.insert(strategyExperimentValidations).values({
        id: randomUUID(), runId, validationType: check.id.slice(0, 64), status: check.status,
        details: check, createdAt: now,
      }).onDuplicateKeyUpdate({ set: { status: check.status, details: check, createdAt: now } });
    }
    await tx.update(strategyExperimentRuns).set({
      validationStatus: evaluation.status,
      validationPolicyVersion: policy.version,
    }).where(eq(strategyExperimentRuns.id, runId));
    await tx.insert(strategyExperimentEvents).values({
      runId, eventType: 'validation_evaluated',
      payload: { status: evaluation.status, policyVersion: policy.version, evaluationHash: runEvaluationHash },
      createdAt: now,
    });
  });
  const executionPlan = run.executionPlan as Record<string, unknown>;
  const versionSpec = version.spec as { signal?: { document?: { name?: string } } };
  const report = buildStructuredReport({
    runId, experimentVersionId: run.experimentVersionId, generatedAt: now,
    strategyName: versionSpec.signal?.document?.name ?? result.name,
    specHash: version.specHash, compilerVersion: version.compilerVersion,
    dataset: (executionPlan.datasetSnapshot ?? {}) as Record<string, unknown>,
    execution: executionPlan,
    metrics: result.metrics as Record<string, unknown>,
    validationStatus: evaluation.status, policyVersion: policy.version, checks: evaluation.checks,
    resultHash: run.resultHash, evaluationHash: runEvaluationHash,
  });
  const markdown = renderExperimentMarkdown(report);
  const hash = reportHash(report, markdown);
  const reportRow = {
    id: randomUUID(), runId, templateVersion: EXPERIMENT_REPORT_TEMPLATE_VERSION,
    structuredReport: report, markdown, reportHash: hash, createdAt: now,
  };
  await getDb().insert(strategyExperimentReports).values(reportRow).onDuplicateKeyUpdate({
    set: { structuredReport: report, markdown, reportHash: hash, createdAt: now },
  });
  const [storedReport] = await getDb().select().from(strategyExperimentReports)
    .where(and(eq(strategyExperimentReports.runId, runId), eq(strategyExperimentReports.templateVersion, EXPERIMENT_REPORT_TEMPLATE_VERSION))).limit(1);
  return { type: 'evaluated' as const, evaluation: evaluationRow, plan, report: storedReport };
}

export async function getExperimentReport(runId: string) {
  const [report] = await getDb().select().from(strategyExperimentReports)
    .where(eq(strategyExperimentReports.runId, runId))
    .orderBy(desc(strategyExperimentReports.createdAt)).limit(1);
  return report ?? null;
}

export const EXPERIMENT_REPORT_ARTIFACT_ROOT = resolve(
  process.env.EXPERIMENT_REPORT_ARTIFACT_ROOT || resolve(process.cwd(), '.cache', 'experiment-reports'),
);

export async function enqueueReportArtifact(reportId: string, format: 'html' | 'pdf') {
  const [report] = await getDb().select().from(strategyExperimentReports)
    .where(eq(strategyExperimentReports.id, reportId)).limit(1);
  if (!report) return null;
  const cacheKey = canonicalHash({ reportHash: report.reportHash, format }).slice(0, 128);
  const [existing] = await getDb().select().from(strategyExperimentArtifactJobs)
    .where(eq(strategyExperimentArtifactJobs.cacheKey, cacheKey)).limit(1);
  const now = new Date();
  const retentionDays = format === 'pdf'
    ? Number(process.env.EXPERIMENT_REPORT_PDF_RETENTION_DAYS || 30)
    : Number(process.env.EXPERIMENT_REPORT_HTML_RETENTION_DAYS || 7);
  const expires = new Date(now.getTime() + retentionDays * 24 * 60 * 60 * 1000).toISOString();
  if (existing) {
    if (existing.status !== 'failed') return { job: existing, reused: true };
    await getDb().update(strategyExperimentArtifactJobs).set({
      status: 'queued', artifactUri: null, mimeType: null, byteSize: null, checksum: null,
      generatorVersion: null, completedAt: null, errorMessage: null, attempts: 0,
      expiresAt: expires, updatedAt: now.toISOString(),
    }).where(and(
      eq(strategyExperimentArtifactJobs.id, existing.id),
      eq(strategyExperimentArtifactJobs.status, 'failed'),
    ));
    const [retried] = await getDb().select().from(strategyExperimentArtifactJobs)
      .where(eq(strategyExperimentArtifactJobs.id, existing.id)).limit(1);
    return { job: retried ?? existing, reused: false };
  }
  const row = {
    id: randomUUID(), reportId, format, status: 'queued', cacheKey,
    artifactUri: null, errorMessage: null, attempts: 0,
    expiresAt: expires, createdAt: now.toISOString(), updatedAt: now.toISOString(),
  };
  try {
    await getDb().insert(strategyExperimentArtifactJobs).values(row);
    return { job: row, reused: false };
  } catch (error) {
    const [raced] = await getDb().select().from(strategyExperimentArtifactJobs)
      .where(eq(strategyExperimentArtifactJobs.cacheKey, cacheKey)).limit(1);
    if (raced) return { job: raced, reused: true };
    throw error;
  }
}

export async function processReportArtifactJob(jobId: string, options?: {
  alreadyClaimed?: boolean;
  chromiumExecutable?: string;
  timeoutMs?: number;
}) {
  const [job] = await getDb().select().from(strategyExperimentArtifactJobs)
    .where(eq(strategyExperimentArtifactJobs.id, jobId)).limit(1);
  if (!job || job.status === 'completed') return job ?? null;
  if (!options?.alreadyClaimed) {
    const claim = await getDb().update(strategyExperimentArtifactJobs).set({
      status: 'running', attempts: job.attempts + 1, updatedAt: new Date().toISOString(),
    }).where(and(eq(strategyExperimentArtifactJobs.id, jobId), eq(strategyExperimentArtifactJobs.status, 'queued')));
    if (affectedRows(claim) !== 1) return job;
  }
  const [report] = await getDb().select().from(strategyExperimentReports)
    .where(eq(strategyExperimentReports.id, job.reportId)).limit(1);
  try {
    if (!report) throw new Error('REPORT_NOT_FOUND: 报告不存在');
    const path = await renderReportArtifact(report.markdown, job.cacheKey, job.format as 'html' | 'pdf', {
      artifactRoot: EXPERIMENT_REPORT_ARTIFACT_ROOT,
      chromiumExecutable: options?.chromiumExecutable || process.env.EXPERIMENT_REPORT_CHROMIUM_EXECUTABLE,
      timeoutMs: options?.timeoutMs ?? Number(process.env.EXPERIMENT_REPORT_RENDER_TIMEOUT_MS || 60000),
    });
    const metadata = await describeReportArtifact(path, job.format as 'html' | 'pdf');
    const completedAt = new Date().toISOString();
    await getDb().update(strategyExperimentArtifactJobs).set({
      status: 'completed', artifactUri: path, ...metadata, errorMessage: null,
      updatedAt: completedAt, completedAt,
    }).where(eq(strategyExperimentArtifactJobs.id, jobId));
  } catch (error) {
    await getDb().update(strategyExperimentArtifactJobs).set({
      status: 'failed', errorMessage: error instanceof Error ? error.message : String(error),
      updatedAt: new Date().toISOString(),
    }).where(eq(strategyExperimentArtifactJobs.id, jobId));
  }
  const [updated] = await getDb().select().from(strategyExperimentArtifactJobs)
    .where(eq(strategyExperimentArtifactJobs.id, jobId)).limit(1);
  return updated ?? null;
}

export async function claimNextReportArtifactJob(maxAttempts = 3) {
  const candidates = await getDb().select().from(strategyExperimentArtifactJobs)
    .where(eq(strategyExperimentArtifactJobs.status, 'queued'))
    .orderBy(asc(strategyExperimentArtifactJobs.createdAt)).limit(10);
  for (const job of candidates) {
    if (job.attempts >= maxAttempts) {
      await getDb().update(strategyExperimentArtifactJobs).set({
        status: 'failed', errorMessage: `MAX_ATTEMPTS_EXCEEDED: ${maxAttempts}`,
        updatedAt: new Date().toISOString(),
      }).where(and(eq(strategyExperimentArtifactJobs.id, job.id), eq(strategyExperimentArtifactJobs.status, 'queued')));
      continue;
    }
    const claimed = await getDb().update(strategyExperimentArtifactJobs).set({
      status: 'running', attempts: job.attempts + 1, updatedAt: new Date().toISOString(),
    }).where(and(eq(strategyExperimentArtifactJobs.id, job.id), eq(strategyExperimentArtifactJobs.status, 'queued')));
    if (affectedRows(claimed) === 1) {
      const [updated] = await getDb().select().from(strategyExperimentArtifactJobs)
        .where(eq(strategyExperimentArtifactJobs.id, job.id)).limit(1);
      return updated ?? null;
    }
  }
  return null;
}

export async function recoverStaleReportArtifactJobs(staleBefore: Date, maxAttempts = 3) {
  const stale = await getDb().select().from(strategyExperimentArtifactJobs).where(and(
    eq(strategyExperimentArtifactJobs.status, 'running'),
    lt(strategyExperimentArtifactJobs.updatedAt, staleBefore.toISOString()),
  ));
  let recovered = 0;
  let failed = 0;
  for (const job of stale) {
    const terminal = job.attempts >= maxAttempts;
    const result = await getDb().update(strategyExperimentArtifactJobs).set({
      status: terminal ? 'failed' : 'queued',
      errorMessage: terminal ? `WORKER_STALE_MAX_ATTEMPTS: ${maxAttempts}` : 'WORKER_STALE_RECOVERED',
      updatedAt: new Date().toISOString(),
    }).where(and(eq(strategyExperimentArtifactJobs.id, job.id), eq(strategyExperimentArtifactJobs.status, 'running')));
    if (affectedRows(result) === 1) terminal ? failed++ : recovered++;
  }
  return { recovered, failed };
}

export async function getReportArtifactJob(id: string) {
  const [job] = await getDb().select().from(strategyExperimentArtifactJobs)
    .where(eq(strategyExperimentArtifactJobs.id, id)).limit(1);
  return job ?? null;
}

export async function listExperimentReportHistory(limit = 100) {
  const rows = await getDb().select({
    report: strategyExperimentReports,
    run: strategyExperimentRuns,
    version: {
      id: strategyExperimentVersions.id,
      version: strategyExperimentVersions.version,
      experimentId: strategyExperimentVersions.experimentId,
    },
    experiment: {
      id: strategyExperiments.id,
      name: strategyExperiments.name,
      sourceText: strategyExperiments.sourceText,
    },
    result: {
      id: backtestResults.id,
      name: backtestResults.name,
      datasetSnapshot: backtestResults.datasetSnapshot,
      metrics: backtestResults.metrics,
      startedAt: backtestResults.startedAt,
      completedAt: backtestResults.completedAt,
    },
  }).from(strategyExperimentReports)
    .innerJoin(strategyExperimentRuns, eq(strategyExperimentRuns.id, strategyExperimentReports.runId))
    .innerJoin(strategyExperimentVersions, eq(strategyExperimentVersions.id, strategyExperimentRuns.experimentVersionId))
    .innerJoin(strategyExperiments, eq(strategyExperiments.id, strategyExperimentVersions.experimentId))
    .leftJoin(backtestResults, eq(backtestResults.id, strategyExperimentRuns.backtestResultId))
    .orderBy(desc(strategyExperimentReports.createdAt))
    .limit(Math.min(200, Math.max(1, limit)));
  const reportIds = rows.map((row) => row.report.id);
  const artifacts = reportIds.length > 0
    ? await getDb().select().from(strategyExperimentArtifactJobs)
      .where(inArray(strategyExperimentArtifactJobs.reportId, reportIds))
      .orderBy(desc(strategyExperimentArtifactJobs.createdAt))
    : [];
  return rows.map((row) => ({
    ...row,
    artifacts: artifacts.filter((artifact) => artifact.reportId === row.report.id),
  }));
}

export async function getDownloadableReportArtifact(id: string) {
  const job = await getReportArtifactJob(id);
  if (!job || job.status !== 'completed' || !job.artifactUri) return null;
  if (!isArtifactPathInsideRoot(job.artifactUri, EXPERIMENT_REPORT_ARTIFACT_ROOT)) return null;
  return { job, path: job.artifactUri };
}

export async function heartbeatReportWorker(input: {
  id: string;
  hostname: string;
  pid: number;
  status?: 'running' | 'draining';
}) {
  const now = new Date().toISOString();
  await getDb().insert(strategyExperimentReportWorkers).values({
    id: input.id, hostname: input.hostname, pid: input.pid, status: input.status ?? 'running',
    startedAt: now, heartbeatAt: now, stoppedAt: null,
  }).onDuplicateKeyUpdate({
    set: { status: input.status ?? 'running', heartbeatAt: now, stoppedAt: null },
  });
}

export async function stopReportWorker(id: string) {
  const now = new Date().toISOString();
  await getDb().update(strategyExperimentReportWorkers).set({
    status: 'stopped', heartbeatAt: now, stoppedAt: now,
  }).where(eq(strategyExperimentReportWorkers.id, id));
}

export async function getReportWorkerStatus(staleMs = 45_000) {
  const [jobGroups, workers] = await Promise.all([
    getDb().select({
      status: strategyExperimentArtifactJobs.status,
      count: sql<number>`count(*)`,
      oldestCreatedAt: sql<string | null>`min(${strategyExperimentArtifactJobs.createdAt})`,
    }).from(strategyExperimentArtifactJobs).groupBy(strategyExperimentArtifactJobs.status),
    getDb().select().from(strategyExperimentReportWorkers)
      .orderBy(desc(strategyExperimentReportWorkers.heartbeatAt)).limit(20),
  ]);
  const now = Date.now();
  const activeWorkers = workers.filter((worker) => worker.status !== 'stopped'
    && now - new Date(worker.heartbeatAt).getTime() <= staleMs);
  const countFor = (status: string) => Number(jobGroups.find((group) => group.status === status)?.count ?? 0);
  const oldestQueuedAt = jobGroups.find((group) => group.status === 'queued')?.oldestCreatedAt ?? null;
  return {
    healthy: activeWorkers.length > 0,
    queue: {
      queued: countFor('queued'),
      running: countFor('running'),
      completed: countFor('completed'),
      failed: countFor('failed'),
      oldestQueuedAt,
      oldestQueuedAgeSeconds: oldestQueuedAt
        ? Math.max(0, Math.round((now - new Date(oldestQueuedAt).getTime()) / 1000))
        : 0,
    },
    workers: workers.map((worker) => ({
      ...worker,
      fresh: worker.status !== 'stopped' && now - new Date(worker.heartbeatAt).getTime() <= staleMs,
    })),
  };
}

export async function cleanupExpiredReportArtifacts(now = new Date()) {
  const expired = await getDb().select().from(strategyExperimentArtifactJobs)
    .where(lt(strategyExperimentArtifactJobs.expiresAt, now.toISOString()));
  for (const job of expired) {
    if (job.artifactUri && isArtifactPathInsideRoot(job.artifactUri, EXPERIMENT_REPORT_ARTIFACT_ROOT)) {
      await unlink(job.artifactUri).catch(() => undefined);
    }
    await getDb().delete(strategyExperimentArtifactJobs).where(eq(strategyExperimentArtifactJobs.id, job.id));
  }
  return expired.length;
}
