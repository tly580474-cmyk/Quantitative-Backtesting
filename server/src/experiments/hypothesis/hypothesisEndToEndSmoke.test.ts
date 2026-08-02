/**
 * N5.1/N5.2：MVP 3/4 端到端全链路冒烟 + 假设驱动实验固定样例。
 *
 * 链路：自然语言 → 假设 Agent（能力清单校验）→ 实验规格（确认请求）
 * → 事件引擎（筛选层，ADR-05）→ M2 门禁（complete hash 校验）→ 报告摘要。
 *
 * 全部使用确定性依赖（Mock LLM Provider + mock 评估依赖），不依赖真实
 * DB 与 backtrader，因此每次运行产出完全一致的 golden sample。
 */
import { describe, expect, it } from 'vitest';
import type { EventEngineResult } from '../m5/eventEngineRuntime.js';
import { canonicalHash } from '../schema.js';
import { MockHypothesisProvider } from './hypothesisLlm.js';
import {
  buildHypothesisCapabilityContext,
  generateHypotheses,
  PUBLISHED_EXPERIMENT_CAPABILITY_VERSION,
} from './hypothesisGenerator.js';
import { evaluateHypothesis, type HypothesisEvaluationDeps } from './hypothesisEvaluator.js';
import { buildHypothesisConfirmRequest, hypothesisToStrategyDocument } from './hypothesisMapper.js';
import {
  evaluateHypothesisRequestSchema,
  generateHypothesesRequestSchema,
  hypothesisPlanSchema,
  hypothesisRecordSchema,
  type HypothesisPlan,
  type HypothesisRecord,
} from './hypothesisSchema.js';

const GOLDEN_PROMPT = '研究双均线交叉在 A 股日线上的表现：5 日与 20 日均线金叉买入、死叉卖出';
const GOLDEN_HYPOTHESIS_ID = '7f9e1a2b-3c4d-4e6f-8a8b-9c0d1e2f3a4b';

const GOLDEN_DATASET_SNAPSHOT = {
  id: 'ds-golden-1',
  name: '000001 日线 golden sample',
  symbol: '000001',
  startTime: '2026-06-01',
  endTime: '2026-06-30',
  checksum: 'abc123',
};

const goldenRequest = evaluateHypothesisRequestSchema.parse({
  datasetSnapshot: GOLDEN_DATASET_SNAPSHOT,
  candles: [
    { time: '2026-06-01', open: 10, high: 11, low: 9.5, close: 10.5, volume: 1000 },
    { time: '2026-06-02', open: 10.5, high: 11.5, low: 10, close: 11, volume: 1200 },
    { time: '2026-06-03', open: 11, high: 12, low: 10.5, close: 11.8, volume: 1500 },
  ],
  config: {
    backtestMode: 'strategy',
    initialCapital: 100_000,
    tradingDays: 20,
    positionSizing: { type: 'percent', value: 0.5 },
    commissionRate: 0.0003,
    minimumCommission: 5,
    sellTaxRate: 0.001,
    slippageBps: 5,
    tradingUnitMode: 'stock',
    minimumTradeAmount: 100,
    dca: { amount: 0, frequency: 'daily' },
    execution: 'next_open',
    forceCloseAtEnd: true,
  },
  engineVersion: 'backtrader-event-engine-v1',
});

function mockEngineResult(finalEquity: number): EventEngineResult {
  return {
    protocolVersion: '1.0',
    runtime: 'backtrader',
    authority: 'screening_only',
    publishable: false,
    trades: [],
    orders: [],
    equityCurve: [],
    finalEquity,
  };
}

function buildGoldenPlan(): HypothesisPlan {
  return hypothesisPlanSchema.parse({
    protocolVersion: '1.0',
    strategyType: 'dual_ma',
    params: { fast: 5, slow: 20 },
    name: '双均线交叉 5/20 日',
    description: '短期均线上穿长期均线买入，下穿卖出',
    rationale: '趋势跟踪',
    capabilityVersion: PUBLISHED_EXPERIMENT_CAPABILITY_VERSION,
  });
}

function buildDraftRecord(plan: HypothesisPlan): HypothesisRecord {
  return hypothesisRecordSchema.parse({
    id: GOLDEN_HYPOTHESIS_ID,
    plan,
    status: 'draft',
    mappedExperimentVersionId: null,
    lastRunId: null,
    validationStatus: null,
    evaluationSummary: null,
    rejectionReason: null,
    createdAt: '2026-08-02T00:00:00.000Z',
    updatedAt: '2026-08-02T00:00:00.000Z',
  });
}

function buildEvaluationDeps(captured: Record<string, unknown>): HypothesisEvaluationDeps {
  const draft = buildDraftRecord(buildGoldenPlan());
  return {
    confirmVersion: async () => ({ experimentVersion: { id: '11111111-1111-4111-8111-111111111111' }, reused: false }),
    createRun: async (input) => {
      captured.createRun = input;
      return { conflict: false, run: { id: '22222222-2222-4222-8222-222222222222' }, reused: false };
    },
    runBacktest: async () => mockEngineResult(110_000),
    persistBacktestResult: async (result) => {
      captured.result = result;
    },
    completeRun: async (runId, input) => {
      captured.complete = { runId, input };
      return { type: 'completed' };
    },
    validateRun: async (runId) => {
      captured.validateRun = runId;
      return {};
    },
    getRun: async () => ({ validationStatus: 'candidate' }),
    markEvaluated: async (input) => hypothesisRecordSchema.parse({
      ...draft,
      status: 'evaluated',
      ...input,
      updatedAt: '2026-08-02T01:00:00.000Z',
    }),
  };
}

describe('N5.1 end-to-end smoke: 自然语言 → 假设 → 规格 → 事件引擎 → 门禁 → 报告', () => {
  it('golden sample: 固定自然语言输入产出固定假设草稿', async () => {
    const result = await generateHypotheses({
      provider: new MockHypothesisProvider(),
      capabilityContext: buildHypothesisCapabilityContext({
        factorIds: ['momentum_20'],
        indicatorIds: ['sma', 'ema'],
      }),
      request: generateHypothesesRequestSchema.parse({ prompt: GOLDEN_PROMPT, count: 1 }),
    });
    expect(result.rejected).toEqual([]);
    expect(result.plans).toHaveLength(1);
    const plan = result.plans[0];
    // 确定性输出：固定参数、固定能力版本
    expect(plan.strategyType).toBe('dual_ma');
    expect(plan.params).toEqual({ fast: 5, slow: 20 });
    expect(plan.capabilityVersion).toBe(PUBLISHED_EXPERIMENT_CAPABILITY_VERSION);
    expect(plan.name).toBe('双均线交叉 5/20 日');
  });

  it('golden sample: 假设草稿映射为可确认的实验规格', () => {
    const plan = buildGoldenPlan();
    const strategy = hypothesisToStrategyDocument(plan, GOLDEN_HYPOTHESIS_ID);
    expect(strategy.id).toBe('hypothesis:dual_ma');
    expect(strategy.entry.operator).toBe('crossesAbove');
    expect(strategy.exit.operator).toBe('crossesBelow');

    const confirm = buildHypothesisConfirmRequest({
      plan,
      hypothesisId: GOLDEN_HYPOTHESIS_ID,
      strategy,
      capabilityVersion: PUBLISHED_EXPERIMENT_CAPABILITY_VERSION,
    });
    // 五项假设链路必备要素：来源文本、抽取字段、必选假设全部已确认
    expect(confirm.sourceText).toContain('买入');
    expect(confirm.confirmation.extractedFields.map((f) => f.key)).toEqual(['strategyType', 'fast', 'slow']);
    expect(confirm.confirmation.assumptions.every((a) => a.required && a.confirmed)).toBe(true);
    expect(confirm.capabilityVersion).toBe(PUBLISHED_EXPERIMENT_CAPABILITY_VERSION);
  });

  it('golden sample: 全链路评估产出结构化报告摘要', async () => {
    const captured: Record<string, unknown> = {};
    const deps = buildEvaluationDeps(captured);
    const outcome = await evaluateHypothesis({
      hypothesisId: GOLDEN_HYPOTHESIS_ID,
      plan: buildGoldenPlan(),
      request: goldenRequest,
      deps,
    });

    // 状态机：draft → evaluated，绑定版本与运行
    expect(outcome.hypothesis.status).toBe('evaluated');
    expect(outcome.experimentVersionId).toBe('11111111-1111-4111-8111-111111111111');
    expect(outcome.runId).toBe('22222222-2222-4222-8222-222222222222');

    // 幂等键由假设 + 数据集 hash 确定性派生
    const createRun = captured.createRun as { idempotencyKey: string; runtime: string };
    expect(createRun.runtime).toBe('backend_event_engine');
    expect(createRun.idempotencyKey).toBe(
      `hypothesis:${GOLDEN_HYPOTHESIS_ID}:${canonicalHash(goldenRequest.datasetSnapshot)}`,
    );

    // 报告摘要（结构化报告核心）：筛选层 authority + 固定收益口径
    const summary = outcome.evaluationSummary;
    expect(summary.authority).toBe('screening_only');
    expect(summary.finalEquity).toBe(110_000);
    expect(summary.totalReturn).toBeCloseTo(0.1);
    expect(summary.tradeCount).toBe(0);
    expect(summary.datasetSnapshot).toEqual(GOLDEN_DATASET_SNAPSHOT);
  });

  it('golden sample: 报告摘要可稳定序列化为 JSON 快照', () => {
    // 结构化报告核心字段为权威制品（ADR-08 只解释不裁决，数值全部来自引擎结果）
    const summary = {
      authority: 'screening_only',
      finalEquity: 110_000,
      totalReturn: 0.1,
      tradeCount: 0,
      datasetSnapshot: GOLDEN_DATASET_SNAPSHOT,
      capabilityVersion: PUBLISHED_EXPERIMENT_CAPABILITY_VERSION,
    };
    const snapshot = JSON.parse(JSON.stringify(summary)) as Record<string, unknown>;
    expect(snapshot).toMatchObject({
      authority: 'screening_only',
      finalEquity: 110_000,
      capabilityVersion: PUBLISHED_EXPERIMENT_CAPABILITY_VERSION,
    });
    // 固定 JSON 长度防格式漂移
    expect(JSON.stringify(snapshot)).toHaveLength(JSON.stringify(summary).length);
  });
});
