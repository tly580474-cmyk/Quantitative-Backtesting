import { describe, expect, it } from 'vitest';
import { hypothesisPlanSchema, type HypothesisPlan } from './hypothesisSchema.js';
import { buildHypothesisConfirmRequest, hypothesisToStrategyDocument } from './hypothesisMapper.js';
import { strategyDocumentSchema } from '../../services/strategyGeneration/schema.js';

const plan: HypothesisPlan = hypothesisPlanSchema.parse({
  protocolVersion: '1.0',
  strategyType: 'dual_ma',
  params: { fast: 5, slow: 20 },
  name: '双均线交叉 5/20 日',
  description: '短期均线上穿长期均线买入，下穿卖出',
  rationale: '趋势跟踪',
  capabilityVersion: 'test-capabilities-v1',
});

describe('N3.2 hypothesis → experiment spec mapping', () => {
  it('maps a dual_ma hypothesis to a valid StrategyDocument', () => {
    const document = hypothesisToStrategyDocument(plan, 'hypothesis-id');
    // superRefine 全量校验（指标输出、参数引用、占位 0）必须通过
    const parsed = strategyDocumentSchema.parse(document);
    expect(parsed.id).toBe('hypothesis:dual_ma');
    expect(parsed.indicators.map((node) => node.id)).toEqual(['fast_ma', 'slow_ma']);
    expect(parsed.indicators[0].params).toEqual({ period1: 5 });
    expect(parsed.indicators[1].params).toEqual({ period1: 20 });
    expect(parsed.entry.operator).toBe('crossesAbove');
    expect(parsed.exit.operator).toBe('crossesBelow');
    expect(parsed.metadata.aiGenerationId).toBe('hypothesis-id');
  });

  it('builds a confirmation request with confirmed required assumptions', () => {
    const strategy = hypothesisToStrategyDocument(plan, 'hypothesis-id');
    const request = buildHypothesisConfirmRequest({
      plan,
      hypothesisId: 'hypothesis-id',
      strategy,
      capabilityVersion: 'test-capabilities-v1',
    });
    expect(request.name).toBe(plan.name);
    expect(request.capabilityVersion).toBe('test-capabilities-v1');
    expect(request.confirmation.extractedFields.map((field) => field.key))
      .toEqual(['strategyType', 'fast', 'slow']);
    for (const assumption of request.confirmation.assumptions) {
      expect(assumption.required).toBe(true);
      expect(assumption.confirmed).toBe(true);
    }
    // 确认请求的策略必须可被实验规格接受
    expect(request.strategy.id).toBe(strategy.id);
  });
});
