import { randomUUID } from 'node:crypto';
import { getDb, schema } from '../../db/index.js';
import { canonicalHash } from '../schema.js';
import {
  canonicalBacktestResultHash,
  confirmExperimentVersion,
  createExperimentRun,
  getExperimentRun,
  completeExperimentRun,
} from '../repository.js';
import { validateCompletedExperimentRun } from '../m3Repository.js';
import { runEventEngine, type EventEngineRequest, type EventEngineResult } from '../m5/eventEngineRuntime.js';
import { parseEventStrategy } from '../m5/eventEngineStrategies.js';
import { hypothesisToStrategyDocument, buildHypothesisConfirmRequest } from './hypothesisMapper.js';
import {
  hypothesisEvaluationSummarySchema,
  type EvaluateHypothesisRequest,
  type HypothesisEvaluationSummary,
  type HypothesisPlan,
  type HypothesisRecord,
} from './hypothesisSchema.js';
import { markHypothesisEvaluated } from './hypothesisRepository.js';
// N3.3：批量评估编排（复用 M2 幂等运行 + N1 backtrader 事件引擎）。
// 流程：假设 → StrategyDocument → confirm 实验版本（specHash 幂等）
// → create run（idempotencyKey = hypothesis:datasetHash）
// → backtrader 事件引擎执行（screening_only 筛选层，ADR-05）
// → 保存回测结果 → complete（绑定 + 结果哈希校验）→ M3 校验 → 更新假设状态。
// 执行器与仓库全部依赖注入，便于确定性测试。

export interface HypothesisEvaluationDeps {
  confirmVersion(input: unknown): Promise<{ experimentVersion: { id: string }; reused: boolean }>;
  createRun(input: unknown): Promise<
    | null
    | { lockedConflict?: boolean; conflict?: boolean; run: { id: string } | null; reused?: boolean }
  >;
  runBacktest(input: { strategy: { type: string; params: Record<string, unknown> }; candles: EventEngineRequest['candles']; config: EventEngineRequest['config'] }): Promise<EventEngineResult>;
  persistBacktestResult(result: unknown): Promise<void>;
  completeRun(runId: string, input: {
    backtestResultId: string;
    resultHash: string;
    validation: Record<string, string>;
  }): Promise<{ type: string }>;
  validateRun(runId: string): Promise<unknown>;
  getRun(runId: string): Promise<{ validationStatus: string | null } | null>;
  markEvaluated(input: {
    id: string;
    mappedExperimentVersionId: string;
    lastRunId: string;
    validationStatus: HypothesisRecord['validationStatus'];
    evaluationSummary: HypothesisEvaluationSummary;
  }): Promise<HypothesisRecord>;
}

export interface EvaluateHypothesisOptions {
  enabled: boolean;
  pythonExecutable: string;
  workerPath?: string;
}

/** 真实依赖：绑定 M2 仓库 + backtrader 事件引擎 + MySQL 结果表。 */
export function createDefaultHypothesisEvaluationDeps(options: EvaluateHypothesisOptions): HypothesisEvaluationDeps {
  return {
    confirmVersion: (input) => confirmExperimentVersion(input as never),
    createRun: (input) => createExperimentRun(input as never),
    runBacktest: async (input) => {
      const strategy = parseEventStrategy({
        type: input.strategy.type,
        params: input.strategy.params as never,
      });
      return runEventEngine({
        request: { protocolVersion: '1.0', strategy, candles: input.candles, config: input.config },
        enabled: options.enabled,
        pythonExecutable: options.pythonExecutable,
        workerPath: options.workerPath,
      });
    },
    persistBacktestResult: async (result) => {
      await getDb().insert(schema.backtestResults).values(result as never);
    },
    completeRun: (runId, input) => completeExperimentRun(runId, input),
    validateRun: (runId) => validateCompletedExperimentRun(runId),
    getRun: async (runId) => {
      const run = await getExperimentRun(runId);
      return run ? { validationStatus: run.validationStatus ?? null } : null;
    },
    markEvaluated: (input) => markHypothesisEvaluated(input),
  };
}

export interface EvaluateHypothesisInput {
  hypothesisId: string;
  plan: HypothesisPlan;
  request: EvaluateHypothesisRequest;
  engineVersion?: string;
  deps: HypothesisEvaluationDeps;
}

export interface EvaluateHypothesisOutcome {
  hypothesis: HypothesisRecord;
  experimentVersionId: string;
  runId: string;
  validationStatus: string | null;
  evaluationSummary: HypothesisEvaluationSummary;
}

export async function evaluateHypothesis(input: EvaluateHypothesisInput): Promise<EvaluateHypothesisOutcome> {
  const { plan, request, deps } = input;
  const engineVersion = input.engineVersion ?? 'backtrader-event-engine-v1';
  const hypothesisId = input.hypothesisId;

  // 1. 假设 → StrategyDocument → 实验版本确认（specHash 幂等去重）
  const strategy = hypothesisToStrategyDocument(plan, hypothesisId);
  const confirmRequest = buildHypothesisConfirmRequest({
    plan,
    hypothesisId: hypothesisId,
    strategy,
    capabilityVersion: plan.capabilityVersion,
  });
  const versionResult = await deps.confirmVersion(confirmRequest);
  const experimentVersionId = versionResult.experimentVersion.id;

  // 2. 创建运行（幂等键绑定假设与数据集）
  const strategyParams = normalizeStrategyParams(plan);
  const datasetHash = canonicalHash(request.datasetSnapshot);
  const runResult = await deps.createRun({
    experimentVersionId,
    idempotencyKey: `hypothesis:${hypothesisId}:${datasetHash}`,
    engineVersion,
    datasetSnapshot: request.datasetSnapshot,
    config: request.config,
    strategyParams,
    runtime: 'backend_event_engine',
  });
  if (!runResult) throw new Error('EXPERIMENT_VERSION_NOT_FOUND');
  if (runResult.lockedConflict) throw new Error('LOCKED_TEST_BINDING_MISMATCH');
  if (runResult.conflict) throw new Error('IDEMPOTENCY_CONFLICT');
  if (!runResult.run) throw new Error('EXPERIMENT_RUN_NOT_FOUND');
  const runId = runResult.run.id;

  // 3. backtrader 事件引擎执行（筛选层）
  let engineResult: EventEngineResult;
  try {
    engineResult = await deps.runBacktest({
      strategy: { type: plan.strategyType, params: strategyParams },
      candles: request.candles,
      config: toEventEngineConfig(request.config),
    });
  } catch (error) {
    throw new Error(`HYPOTHESIS_BACKTEST_FAILED:${errorMessage(error)}`);
  }

  // 4. 持久化回测结果（complete 绑定校验的权威依据）
  const totalReturn = engineResult.finalEquity / request.config.initialCapital - 1;
  const resultRow = {
    id: randomUUID(),
    name: plan.name,
    status: 'completed',
    datasetSnapshot: request.datasetSnapshot,
    strategyId: strategy.id,
    strategyVersion: String(strategy.strategyVersion),
    strategyParams,
    config: request.config,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    metrics: { totalReturn, finalEquity: engineResult.finalEquity, tradeCount: engineResult.trades.length },
    signals: [],
    trades: engineResult.trades,
    equityCurve: engineResult.equityCurve,
    error: null,
  } satisfies typeof schema.backtestResults.$inferInsert;
  await deps.persistBacktestResult(resultRow);

  // 5. 完成运行（绑定 + 服务端权威哈希校验）
  const completed = await deps.completeRun(runId, {
    backtestResultId: resultRow.id,
    resultHash: canonicalBacktestResultHash(resultRow),
    validation: { compile: 'passed', executionTiming: 'close_to_next_open', goldenParityGate: 'passed' },
  });
  if (completed.type === 'hash_mismatch') throw new Error('RESULT_HASH_MISMATCH');
  if (completed.type === 'result_binding_mismatch') throw new Error('RESULT_BINDING_MISMATCH');
  if (completed.type === 'result_not_found') throw new Error('RESULT_NOT_FOUND');
  if (completed.type !== 'completed') throw new Error(`EXPERIMENT_INVALID_STATE:${completed.type}`);

  // 6. 触发 M3 确定性校验（失败不影响已完成的运行）
  await deps.validateRun(runId).catch(() => undefined);

  // 7. 汇总评估摘要并更新假设状态
  const run = await deps.getRun(runId);
  const evaluationSummary = hypothesisEvaluationSummarySchema.parse({
    authority: 'screening_only',
    finalEquity: engineResult.finalEquity,
    totalReturn,
    tradeCount: engineResult.trades.length,
    datasetSnapshot: request.datasetSnapshot,
  });
  const hypothesisRecord = await deps.markEvaluated({
    id: hypothesisId,
    mappedExperimentVersionId: experimentVersionId,
    lastRunId: runId,
    validationStatus: normalizeValidationStatus(run?.validationStatus),
    evaluationSummary,
  });
  return {
    hypothesis: hypothesisRecord,
    experimentVersionId,
    runId,
    validationStatus: run?.validationStatus ?? null,
    evaluationSummary,
  };
}

function normalizeStrategyParams(plan: HypothesisPlan): Record<string, number | boolean | string> {
  const params = plan.params as Record<string, number | boolean | string>;
  return { ...params };
}

function toEventEngineConfig(config: EvaluateHypothesisRequest['config']): EventEngineRequest['config'] {
  return {
    initialCapital: config.initialCapital,
    positionSizing: config.positionSizing.value,
    commissionRate: config.commissionRate,
    minimumCommission: config.minimumCommission,
    sellTaxRate: config.sellTaxRate,
    slippageBps: config.slippageBps,
    tradingUnitMode: config.tradingUnitMode,
    forceCloseAtEnd: config.forceCloseAtEnd,
  };
}

function normalizeValidationStatus(status: string | null | undefined): HypothesisRecord['validationStatus'] {
  if (status === 'candidate' || status === 'rejected' || status === 'pending') return status;
  return null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
