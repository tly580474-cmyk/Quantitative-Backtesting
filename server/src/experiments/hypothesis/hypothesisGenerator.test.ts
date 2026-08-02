import { describe, expect, it } from 'vitest';
import { MockHypothesisProvider } from './hypothesisLlm.js';
import {
  buildHypothesisCapabilityContext,
  formatCapabilityContext,
  generateHypotheses,
  PUBLISHED_EXPERIMENT_CAPABILITY_VERSION,
} from './hypothesisGenerator.js';
import {
  listEventStrategyCatalog,
  listPublishedEventStrategyCatalog,
  PUBLISHED_EVENT_STRATEGY_IDS,
} from '../m5/eventEngineStrategies.js';
import { generateHypothesesRequestSchema } from './hypothesisSchema.js';

describe('N3.1 hypothesis generation', () => {
  it('generates draft plans within the event-engine whitelist', async () => {
    const result = await generateHypotheses({
      provider: new MockHypothesisProvider(),
      capabilityContext: buildHypothesisCapabilityContext({
        factorIds: ['momentum_20', 'reversal_5'],
        indicatorIds: ['sma', 'ema'],
      }),
      request: generateHypothesesRequestSchema.parse({ count: 5 }),
    });
    expect(result.rejected).toEqual([]);
    expect(result.plans.length).toBeGreaterThan(0);
    for (const plan of result.plans) {
      expect(plan.strategyType).toBe('dual_ma');
      expect(plan.name.length).toBeGreaterThan(0);
      expect(plan.description.length).toBeGreaterThan(0);
      expect(plan.rationale.length).toBeGreaterThan(0);
      const params = plan.params as { fast: number; slow: number };
      expect(Number.isInteger(params.fast)).toBe(true);
      expect(Number.isInteger(params.slow)).toBe(true);
      expect(params.fast).toBeLessThan(params.slow);
    }
  });

  it('rejects hypotheses referencing capabilities outside the boundary', async () => {
    const result = await generateHypotheses({
      provider: {
        async generateHypotheses() {
          return {
            hypotheses: [
              { name: '非法策略', strategyType: 'neural_net', params: {}, description: 'x', rationale: 'x' },
              { name: '越界参数', strategyType: 'dual_ma', params: { fast: 5000, slow: 10 }, description: 'x', rationale: 'x' },
            ],
          };
        },
      },
      capabilityContext: buildHypothesisCapabilityContext(),
      request: generateHypothesesRequestSchema.parse({ count: 2 }),
    });
    expect(result.plans).toEqual([]);
    expect(result.rejected).toHaveLength(2);
    expect(result.rejected.some((item) => item.name === '非法策略')).toBe(true);
  });

  it('returns an empty plan list when every hypothesis fails boundary validation', async () => {
    const result = await generateHypotheses({
      provider: {
        async generateHypotheses() {
          return { hypotheses: [{ name: 'x', strategyType: 'unknown', params: {}, description: 'x', rationale: 'x' }] };
        },
      },
      capabilityContext: buildHypothesisCapabilityContext(),
      request: generateHypothesesRequestSchema.parse({ count: 1 }),
    });
    expect(result.plans).toEqual([]);
    expect(result.rejected).toHaveLength(1);
  });

  it('N5.4 only publishes strategies that passed golden-parity acceptance', () => {
    const published = listPublishedEventStrategyCatalog();
    // 已发布清单中的策略必须全部通过黄金样例验收
    for (const entry of published) {
      expect(PUBLISHED_EVENT_STRATEGY_IDS.has(entry.id)).toBe(true);
      const full = listEventStrategyCatalog().find((item) => item.id === entry.id);
      expect(full?.goldenParityLocked).toBe(true);
    }
    // 能力上下文只向 LLM 暴露已发布策略，且不泄露验收内部字段
    const context = formatCapabilityContext(buildHypothesisCapabilityContext());
    const parsed = JSON.parse(context) as { strategies: Array<Record<string, unknown>> };
    for (const strategy of parsed.strategies) {
      expect(PUBLISHED_EVENT_STRATEGY_IDS.has(String(strategy.id))).toBe(true);
      expect(strategy).not.toHaveProperty('goldenParityLocked');
    }
  });

  it('N5.4 ignores a forged capabilityVersion from the LLM', async () => {
    const result = await generateHypotheses({
      provider: {
        async generateHypotheses() {
          return {
            hypotheses: [{
              name: '伪造能力版本',
              strategyType: 'dual_ma',
              params: { fast: 5, slow: 20 },
              description: 'x',
              rationale: 'x',
              capabilityVersion: 'forged-capability-v999',
            }],
          };
        },
      },
      capabilityContext: buildHypothesisCapabilityContext(),
      request: generateHypothesesRequestSchema.parse({ count: 1 }),
    });
    expect(result.rejected).toEqual([]);
    expect(result.plans).toHaveLength(1);
    expect(result.plans[0].capabilityVersion).toBe(PUBLISHED_EXPERIMENT_CAPABILITY_VERSION);
  });

  it('N5.3 rejects adversarial oversized inputs at the schema boundary', () => {
    // 超大 prompt（> 4000）与越界 count（> 20）在进入 Agent 前即被拒绝
    expect(() => generateHypothesesRequestSchema.parse({
      prompt: 'x'.repeat(4001),
      count: 5,
    })).toThrow();
    expect(() => generateHypothesesRequestSchema.parse({
      count: 21,
    })).toThrow();
    expect(() => generateHypothesesRequestSchema.parse({
      count: 0,
    })).toThrow();
    // 边界内输入仍然合法
    expect(generateHypothesesRequestSchema.parse({
      prompt: 'x'.repeat(4000),
      count: 20,
    }).count).toBe(20);
  });
});
