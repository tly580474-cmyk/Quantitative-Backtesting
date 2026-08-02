import { z } from 'zod';

// N3：假设生成 Agent 协议。
// 假设（Hypothesis）= 一条可检验的研究假设：绑定事件引擎白名单策略
// （当前 dual_ma，黄金样例已锁定）+ 参数 + LLM 生成的理由/描述。
// 状态机：draft → evaluated（经 M2 幂等运行 + backtrader 评估）
//         draft → rejected（人工否决）
// 约束：ADR-05 事件引擎只做筛选，评估结果不直接发布；
//       假设不直接运行，全部经实验版本确认后进入 M2 流程。

/** 可被批量评估的假设必须落在事件引擎白名单内（与 m5/eventEngineStrategies.ts 同步） */
export const hypothesisStrategyTypeSchema = z.enum(['dual_ma']);

export const hypothesisStatusSchema = z.enum(['draft', 'evaluated', 'rejected']);

export type HypothesisStatus = z.infer<typeof hypothesisStatusSchema>;

const paramValueSchema = z.union([z.number().finite(), z.boolean(), z.string()]);

export const hypothesisPlanSchema = z.strictObject({
  protocolVersion: z.literal('1.0'),
  /** 白名单策略类型（必须存在于事件引擎注册表） */
  strategyType: hypothesisStrategyTypeSchema,
  /** 策略参数，经事件引擎白名单参数 Schema 校验 */
  params: z.record(z.string(), paramValueSchema),
  /** LLM 生成的假设名称 */
  name: z.string().trim().min(1).max(255),
  /** LLM 生成的假设描述 */
  description: z.string().trim().min(1).max(2000),
  /** LLM 生成该假设的理由（能力清单驱动） */
  rationale: z.string().trim().min(1).max(4000),
  /** 生成时所依据的能力清单版本 */
  capabilityVersion: z.string().min(1).max(64),
});

export type HypothesisPlan = z.infer<typeof hypothesisPlanSchema>;

export const hypothesisEvaluationSummarySchema = z.object({
  /** backtrader 事件引擎为筛选层（ADR-05），不直接发布 */
  authority: z.literal('screening_only'),
  finalEquity: z.number().finite(),
  totalReturn: z.number().finite(),
  tradeCount: z.number().int().nonnegative(),
  datasetSnapshot: z.object({
    id: z.string().min(1),
    name: z.string().optional(),
    symbol: z.string().min(1),
    startTime: z.string().min(1),
    endTime: z.string().min(1),
    checksum: z.string().min(1),
  }),
});

export type HypothesisEvaluationSummary = z.infer<typeof hypothesisEvaluationSummarySchema>;

export const hypothesisRecordSchema = z.object({
  id: z.string().uuid(),
  plan: hypothesisPlanSchema,
  status: hypothesisStatusSchema,
  mappedExperimentVersionId: z.string().uuid().nullable(),
  lastRunId: z.string().uuid().nullable(),
  validationStatus: z.enum(['pending', 'candidate', 'rejected']).nullable(),
  evaluationSummary: hypothesisEvaluationSummarySchema.nullable(),
  rejectionReason: z.string().max(1000).nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type HypothesisRecord = z.infer<typeof hypothesisRecordSchema>;

export const generateHypothesesRequestSchema = z.strictObject({
  /** 可选的研究方向提示词（默认由能力清单驱动） */
  prompt: z.string().trim().max(4000).optional(),
  /** 生成条数 */
  count: z.number().int().min(1).max(20).default(8),
  /** 可选模型名（默认用配置的 OPENAI_MODEL） */
  model: z.string().trim().min(1).max(128).optional(),
});

export type GenerateHypothesesRequest = z.infer<typeof generateHypothesesRequestSchema>;

export const evaluateHypothesisRequestSchema = z.strictObject({
  datasetSnapshot: z.object({
    id: z.string().min(1),
    name: z.string().optional(),
    symbol: z.string().min(1),
    startTime: z.string().min(1),
    endTime: z.string().min(1),
    checksum: z.string().min(1),
  }),
  candles: z.array(z.object({
    time: z.string().min(1),
    open: z.number().positive().finite(),
    high: z.number().positive().finite(),
    low: z.number().positive().finite(),
    close: z.number().positive().finite(),
    volume: z.number().nonnegative().finite().optional(),
  })).min(2).max(2_000_000),
  config: z.object({
    backtestMode: z.literal('strategy'),
    initialCapital: z.number().positive(),
    tradingDays: z.number().int().nonnegative(),
    positionSizing: z.object({ type: z.literal('percent'), value: z.number().positive().max(1) }),
    commissionRate: z.number().nonnegative(),
    minimumCommission: z.number().nonnegative(),
    sellTaxRate: z.number().nonnegative(),
    slippageBps: z.number().nonnegative(),
    tradingUnitMode: z.enum(['stock', 'index']),
    minimumTradeAmount: z.number().nonnegative(),
    dca: z.object({
      amount: z.number().nonnegative(),
      frequency: z.enum(['daily', 'weekly', 'monthly']),
    }),
    execution: z.literal('next_open'),
    forceCloseAtEnd: z.boolean(),
  }),
  engineVersion: z.string().min(1).max(64).optional(),
});

export type EvaluateHypothesisRequest = z.infer<typeof evaluateHypothesisRequestSchema>;

export const rejectHypothesisRequestSchema = z.strictObject({
  reason: z.string().trim().min(1).max(1000),
});

export type RejectHypothesisRequest = z.infer<typeof rejectHypothesisRequestSchema>;
