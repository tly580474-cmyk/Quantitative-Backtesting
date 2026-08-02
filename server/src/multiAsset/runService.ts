import { randomUUID } from 'node:crypto';
import { canonicalHash } from '../experiments/schema.js';
import { generateRebalancePlan } from './duckdbPlanGenerator.js';
import { executeRebalancePlan } from './execution.js';
import { generateRebalancePlanWithPython } from './pythonPlanWorker.js';
import { defaultMultiAssetArtifactRoot, persistMultiAssetJsonArtifact } from './artifactStore.js';
import { validateMultiAssetGovernanceBinding } from './governanceBinding.js';
import { finalizeMultiAssetExtensionReport } from './extensionSchema.js';
import {
  cancelClaimedMultiAssetRun,
  claimQueuedMultiAssetRun,
  completeMultiAssetRun,
  getMultiAssetPlanVersion,
  getMultiAssetRun,
  renewMultiAssetRunLease,
  settleMultiAssetRunFailure,
  storeFrozenMultiAssetPlan,
  updateMultiAssetRunProgress,
} from './repository.js';
import { hashMultiAssetPlan, multiAssetPlanSchema, type RebalancePlan } from './schema.js';
import { applyModelScores } from './modelScoreBridge.js';
import {
  loadSnapshotExecutionBars,
  loadSnapshotMomentumInput,
  snapshotMultiAssetConfigSchema,
  type SnapshotMultiAssetConfig,
} from './snapshotInput.js';

const RUN_LEASE_MS = 10 * 60_000;
const RUN_HEARTBEAT_MS = 30_000;

export async function freezeSnapshotMultiAssetPlan(input: {
  name: string;
  snapshotRoot: string;
  config: SnapshotMultiAssetConfig;
}) {
  const config = snapshotMultiAssetConfigSchema.parse(input.config);
  assertSnapshotConfigSemantics(config);
  const resolved = await loadSnapshotMomentumInput({ snapshotRoot: input.snapshotRoot, ...config });
  await validateMultiAssetGovernanceBinding({
    factorVersionId: config.factorVersionId,
    strategyVersionId: config.strategyVersionId,
    snapshotId: resolved.sourcePlan.snapshotId,
  });
  return storeFrozenMultiAssetPlan({ name: input.name, plan: resolved.sourcePlan, snapshotConfig: config });
}

export async function processMultiAssetRun(
  runId: string,
  options: { snapshotRoot: string; pythonExecutable?: string; artifactRoot?: string },
) {
  const runStartedAt = performance.now();
  let peakRssBytes = process.memoryUsage().rss;
  const sampleMemory = () => { peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss); };
  const workerToken = randomUUID();
  const claimed = await claimQueuedMultiAssetRun(runId, workerToken, RUN_LEASE_MS);
  if (!claimed) return getMultiAssetRun(runId);
  const heartbeat = setInterval(() => {
    void renewMultiAssetRunLease(runId, workerToken, RUN_LEASE_MS).catch(() => undefined);
  }, RUN_HEARTBEAT_MS);
  heartbeat.unref?.();
  try {
    const storedPlan = await getMultiAssetPlanVersion(claimed.planVersionId);
    if (!storedPlan) throw codedError('MULTI_ASSET_PLAN_NOT_FOUND', '冻结计划不存在');
    const sourcePlan = multiAssetPlanSchema.parse(storedPlan.plan);
    const config = snapshotMultiAssetConfigSchema.parse(storedPlan.snapshotConfig);
    await requireProgress(runId, workerToken, 'loading_snapshot', 10);
    await throwIfCancelled(runId, workerToken);
    const input = await loadSnapshotMomentumInput({ snapshotRoot: options.snapshotRoot, ...config });
    sampleMemory();
    // Historical v1 plans predate filterAudit. Preserve their exact source-plan hash instead of
    // silently upgrading a frozen artifact during replay.
    if (!sourcePlan.universePlan.filterAudit) delete input.sourcePlan.universePlan.filterAudit;
    if (hashMultiAssetPlan(input.sourcePlan) !== storedPlan.planHash
      || input.sourcePlan.snapshotId !== sourcePlan.snapshotId) {
      throw codedError('FROZEN_PLAN_BINDING_MISMATCH', '当前只读快照与冻结计划不一致，必须创建新计划版本');
    }
    await requireProgress(runId, workerToken, 'building_rebalance_plan', 35);
    await throwIfCancelled(runId, workerToken);
    const optimizerStartedAt = performance.now();
    // N2：模型分数注入——模型作为虚拟因子进入排名（planVersion 1.3）
    let featureRows = input.rows;
    let modelScoreHash: string | undefined;
    if (sourcePlan.mlModelPlan) {
      const applied = await applyModelScores({
        mlPlan: sourcePlan.mlModelPlan,
        rows: input.rows,
        enabled: Boolean(options.pythonExecutable),
        pythonExecutable: options.pythonExecutable ?? 'python',
      });
      featureRows = applied.rows;
      modelScoreHash = applied.scoreHash;
    }
    const [duckdbOutput, pythonPlan] = await Promise.all([
      generateRebalancePlan(sourcePlan, featureRows).then((plan) => ({
        plan,
        durationMs: performance.now() - optimizerStartedAt,
      })),
      generateRebalancePlanWithPython({
        plan: sourcePlan, rows: featureRows,
        pythonExecutable: options.pythonExecutable, timeoutMs: 120_000,
      }),
    ]);
    const duckdbPlan = duckdbOutput.plan;
    sampleMemory();
    assertCrossRuntimeParity(duckdbPlan, pythonPlan);
    await persistMultiAssetJsonArtifact({
      artifactRoot: options.artifactRoot ?? defaultMultiAssetArtifactRoot(options.snapshotRoot),
      runId, kind: 'rebalance_plan', value: duckdbPlan,
    });
    await requireProgress(runId, workerToken, 'loading_execution_bars', 65);
    await throwIfCancelled(runId, workerToken);
    const bars = await loadSnapshotExecutionBars(options.snapshotRoot, duckdbPlan, config.endDate);
    await requireProgress(runId, workerToken, 'executing_portfolio', 80);
    const executionResult = executeRebalancePlan({
      sourcePlan, rebalancePlan: duckdbPlan, bars, initialCash: claimed.initialCash,
    });
    sampleMemory();
    await persistMultiAssetJsonArtifact({
      artifactRoot: options.artifactRoot ?? defaultMultiAssetArtifactRoot(options.snapshotRoot),
      runId, kind: 'execution_result', value: executionResult,
    });
    const optimizerResults = duckdbPlan.decisions
      .map((decision) => decision.optimizerResult).filter((result) => result !== undefined);
    const industryDeviations = optimizerResults.map((result) => {
      const actual = result.industryExposure ?? {};
      const benchmark = result.benchmarkIndustryExposure ?? {};
      const codes = [...new Set([...Object.keys(actual), ...Object.keys(benchmark)])];
      return Math.max(0, ...codes.map((code) => Math.abs((actual[code] ?? 0) - (benchmark[code] ?? 0))));
    });
    const extensionReport = finalizeMultiAssetExtensionReport({
      protocolVersion: '1.0',
      runId,
      sourcePlanHash: storedPlan.planHash,
      rebalancePlanHash: duckdbPlan.planHash,
      pythonPlanHash: pythonPlan.planHash,
      metrics: {
        factorCount: sourcePlan.factorPlan?.factors.length ?? 1,
        averageUniverseSize: duckdbPlan.decisions.reduce((sum, decision) => sum + decision.eligibleUniverse.length, 0)
          / duckdbPlan.decisions.length,
        maximumUniverseSize: Math.max(...duckdbPlan.decisions.map((decision) => decision.eligibleUniverse.length)),
        optimizerDecisionCount: optimizerResults.length,
        optimizerPlanningDurationMs: duckdbOutput.durationMs,
        totalDurationMs: performance.now() - runStartedAt,
        peakRssBytes,
        infeasibleRate: 0,
        maximumIndustryDeviation: Math.max(0, ...industryDeviations),
        averageTurnover: optimizerResults.length
          ? optimizerResults.reduce((sum, result) => sum + result.turnover, 0) / optimizerResults.length
          : 0,
      },
      generatedAt: new Date().toISOString(),
    });
    await persistMultiAssetJsonArtifact({
      artifactRoot: options.artifactRoot ?? defaultMultiAssetArtifactRoot(options.snapshotRoot),
      runId, kind: 'extension_report', value: extensionReport,
    });
    await throwIfCancelled(runId, workerToken);
    const resultHash = canonicalHash({
      sourcePlanHash: storedPlan.planHash,
      rebalancePlanHash: duckdbPlan.planHash,
      pythonPlanHash: pythonPlan.planHash,
      modelScoreHash,
      executionResult,
    });
    if (!await completeMultiAssetRun({
      id: runId, workerToken, rebalancePlan: duckdbPlan, executionResult, resultHash,
    })) {
      throw codedError('MULTI_ASSET_RUN_STATE_CONFLICT', '运行完成时状态已发生变化');
    }
    return getMultiAssetRun(runId);
  } catch (error) {
    const normalized = normalizeRunError(error);
    if (normalized.code === 'MULTI_ASSET_RUN_CANCELLED') {
      await cancelClaimedMultiAssetRun(runId, workerToken);
    } else {
      await settleMultiAssetRunFailure({
        id: runId, workerToken, errorCode: normalized.code, errorMessage: normalized.message,
        retryable: isRetryableRunError(normalized.code),
      });
    }
    return getMultiAssetRun(runId);
  } finally {
    clearInterval(heartbeat);
  }
}

async function throwIfCancelled(runId: string, workerToken: string): Promise<void> {
  const run = await getMultiAssetRun(runId);
  if (!run || run.workerToken !== workerToken) throw codedError('MULTI_ASSET_RUN_STATE_CONFLICT', '运行租约已失效');
  if (run.cancelRequestedAt) throw codedError('MULTI_ASSET_RUN_CANCELLED', '运行已由用户取消');
}

export function isRetryableRunError(code: string): boolean {
  return new Set([
    'PYTHON_PLAN_WORKER_TIMEOUT', 'PYTHON_PLAN_WORKER_START_FAILED',
    'DUCKDB_BUSY', 'DATABASE_UNAVAILABLE', 'EXECUTION_SNAPSHOT_TEMPORARILY_UNAVAILABLE',
  ]).has(code);
}

export function assertCrossRuntimeParity(duckdbPlan: RebalancePlan, pythonPlan: RebalancePlan): void {
  if (canonicalHash(duckdbPlan.decisions) !== canonicalHash(pythonPlan.decisions)) {
    throw codedError('CROSS_RUNTIME_PARITY_FAILED', 'Python 与 DuckDB 的调仓决策不一致');
  }
}

export function assertSnapshotConfigSemantics(configInput: SnapshotMultiAssetConfig | unknown): void {
  const config = snapshotMultiAssetConfigSchema.parse(configInput);
  const start = Date.parse(`${config.startDate}T00:00:00Z`);
  const end = Date.parse(`${config.endDate}T00:00:00Z`);
  if (start > end) throw codedError('MULTI_ASSET_DATE_RANGE_INVALID', '开始日期不能晚于结束日期');
  if (end - start > 5 * 366 * 24 * 60 * 60 * 1000) {
    throw codedError('MULTI_ASSET_DATE_RANGE_TOO_LARGE', '首期单次多资产研究区间不能超过五年');
  }
  if (config.universeSpec.type === 'all_a' && end - start > 2 * 366 * 24 * 60 * 60 * 1000) {
    throw codedError('ALL_A_DATE_RANGE_TOO_LARGE', '全 A 单次研究区间不能超过两年，请拆分计划以控制资源占用');
  }
  const gross = Math.min(config.maxGrossExposure, 1 - config.minCashWeight);
  if (config.topN * config.maxSingleWeight + 1e-12 < gross) {
    throw codedError('MULTI_ASSET_WEIGHT_CAP_INFEASIBLE', '入选数量与单标的权重上限无法达到目标总仓位');
  }
}

async function requireProgress(
  runId: string,
  workerToken: string,
  stage: string,
  percent: number,
): Promise<void> {
  if (!await updateMultiAssetRunProgress(runId, workerToken, { stage, percent }, RUN_LEASE_MS)) {
    throw codedError('MULTI_ASSET_RUN_STATE_CONFLICT', `运行状态不允许进入 ${stage}`);
  }
}

function codedError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function normalizeRunError(error: unknown): { code: string; message: string } {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return { code: error.code, message: error instanceof Error ? error.message : String(error) };
  }
  const message = error instanceof Error ? error.message : String(error);
  const known = message.match(/^([A-Z][A-Z0-9_]+)(?::|$)/)?.[1];
  return { code: known ?? 'MULTI_ASSET_RUN_FAILED', message };
}
