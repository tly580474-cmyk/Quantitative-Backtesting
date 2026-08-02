import { describe, expect, it } from 'vitest';
import { MockHypothesisProvider } from './hypothesisLlm.js';
import {
  buildHypothesisCapabilityContext,
  generateHypotheses,
} from './hypothesisGenerator.js';
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
});
