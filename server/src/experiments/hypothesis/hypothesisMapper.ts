import { strategyDocumentSchema, type StrategyDocument } from '../../services/strategyGeneration/schema.js';
import type { HypothesisPlan } from './hypothesisSchema.js';

// N3.2：假设 → 实验规格映射（不直接运行）。
// dual_ma 假设映射为 visual_strategy DSL 的 StrategyDocument（sma 双均线交叉），
// 与事件引擎/TS 引擎的参数与撮合口径对齐（黄金样例已锁定）。
// 产出可提交 `POST /api/experiments/versions/confirm` 的确认请求。

const HYPOTHESIS_STRATEGY_VERSION = 1;

/** 假设 → StrategyDocument（不可变，specHash 幂等去重的依据）。 */
export function hypothesisToStrategyDocument(
  plan: HypothesisPlan,
  hypothesisId: string,
): StrategyDocument {
  const params = plan.params as { fast: number; slow: number };
  const now = new Date().toISOString();
  const document = {
    schemaVersion: '1.0' as const,
    id: `hypothesis:${plan.strategyType}`,
    name: plan.name,
    description: plan.description,
    strategyVersion: HYPOTHESIS_STRATEGY_VERSION,
    parameters: [],
    indicators: [
      {
        id: 'fast_ma',
        indicatorId: 'sma',
        params: { period1: params.fast },
        outputs: [{ key: 'sma1', label: 'SMA', type: 'number' as const }],
      },
      {
        id: 'slow_ma',
        indicatorId: 'sma',
        params: { period1: params.slow },
        outputs: [{ key: 'sma1', label: 'SMA', type: 'number' as const }],
      },
    ],
    entry: {
      type: 'condition' as const,
      id: 'entry_fast_crosses_slow',
      left: { type: 'indicator' as const, nodeId: 'fast_ma', output: 'sma1', offset: 0 },
      operator: 'crossesAbove' as const,
      right: { type: 'indicator' as const, nodeId: 'slow_ma', output: 'sma1', offset: 0 },
    },
    exit: {
      type: 'condition' as const,
      id: 'exit_fast_crosses_slow',
      left: { type: 'indicator' as const, nodeId: 'fast_ma', output: 'sma1', offset: 0 },
      operator: 'crossesBelow' as const,
      right: { type: 'indicator' as const, nodeId: 'slow_ma', output: 'sma1', offset: 0 },
    },
    risk: [],
    metadata: {
      source: 'ai' as const,
      createdAt: now,
      updatedAt: now,
      aiGenerationId: hypothesisId,
    },
  };
  return strategyDocumentSchema.parse(document);
}

/** 构造实验版本确认请求（假设的自述即确认单，必选假设已确认）。 */
export function buildHypothesisConfirmRequest(input: {
  plan: HypothesisPlan;
  hypothesisId: string;
  strategy: StrategyDocument;
  capabilityVersion: string;
}): {
  name: string;
  sourceText: string;
  strategy: StrategyDocument;
  confirmation: {
    sourceText: string;
    extractedFields: Array<{ key: string; label: string; value: string; evidencePath: string }>;
    assumptions: Array<{
      id: string;
      label: string;
      selectedValue: string;
      options: string[];
      reason: string;
      required: boolean;
      confirmed: boolean;
    }>;
  };
  capabilityVersion: string;
} {
  const { plan } = input;
  const params = plan.params as { fast: number; slow: number };
  return {
    name: plan.name.slice(0, 255),
    sourceText: plan.description,
    strategy: input.strategy,
    confirmation: {
      sourceText: plan.description,
      extractedFields: [
        { key: 'strategyType', label: '策略类型', value: plan.strategyType, evidencePath: 'strategyType' },
        { key: 'fast', label: '快速均线周期', value: String(params.fast), evidencePath: 'params.fast' },
        { key: 'slow', label: '慢速均线周期', value: String(params.slow), evidencePath: 'params.slow' },
      ],
      assumptions: [
        {
          id: 'strategy-type',
          label: '策略类型',
          selectedValue: plan.strategyType,
          options: [plan.strategyType],
          reason: '由假设生成 Agent 在能力清单白名单内产生',
          required: true,
          confirmed: true,
        },
        {
          id: 'strategy-params',
          label: '策略参数',
          selectedValue: `fast=${params.fast}, slow=${params.slow}`,
          options: [`fast=${params.fast}, slow=${params.slow}`],
          reason: '假设声明的参数网格',
          required: true,
          confirmed: true,
        },
      ],
    },
    capabilityVersion: input.capabilityVersion,
  };
}
