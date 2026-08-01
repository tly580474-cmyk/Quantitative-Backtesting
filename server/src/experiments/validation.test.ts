import { describe, expect, it } from 'vitest';
import { buildPerturbationPlan, buildSampleIsolationPlan, evaluateDeterministicGate, validateStaticCausality } from './validation.js';

describe('M3 experiment validation', () => {
  it('isolates train, validation and locked test with purge and embargo', () => {
    const times = Array.from({ length: 100 }, (_, index) => `2026-01-${String(index + 1).padStart(3, '0')}`);
    const plan = buildSampleIsolationPlan(times);
    expect(plan.ranges.map((range) => range.kind)).toEqual(['train', 'validation', 'locked_test']);
    expect(plan.ranges[1].startIndex).toBeGreaterThan(plan.ranges[0].endIndex + 1);
    expect(plan.ranges[2].startIndex).toBeGreaterThan(plan.ranges[1].endIndex + 1);
    expect(plan.walkForward).toHaveLength(3);
  });

  it('rejects an injected future offset', () => {
    const checks = validateStaticCausality({ signal: { entry: { left: { type: 'market', field: 'close', offset: 1 } } } });
    expect(checks).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'failed', category: 'causality' })]));
  });

  it('does not treat explanatory prose as executable future data', () => {
    const checks = validateStaticCausality({ description: '本策略不使用未来函数' });
    expect(checks).toEqual([expect.objectContaining({ status: 'passed' })]);
  });

  it('builds deterministic parameter, cost, date and delay perturbations', () => {
    const cases = buildPerturbationPlan({ period: 20, enabled: true });
    expect(cases.filter((item) => item.category === 'parameter')).toHaveLength(4);
    expect(new Set(cases.map((item) => item.category))).toEqual(new Set(['parameter', 'cost', 'date', 'delay']));
  });

  it('keeps a passing run pending until locked test and perturbations exist', () => {
    const result = evaluateDeterministicGate({
      metrics: { totalReturn: 0.1, maxDrawdown: 0.1, tradeCount: 5 },
      lockedTestOpened: false,
      staticChecks: [], dynamicChecks: [], perturbationWorstDecay: null,
    });
    expect(result.status).toBe('pending');
  });

  it('rejects a negative locked-test return even when the full sample is positive', () => {
    const result = evaluateDeterministicGate({
      metrics: { totalReturn: 0.2, maxDrawdown: 0.1, tradeCount: 5 },
      lockedTestOpened: true, staticChecks: [], dynamicChecks: [], perturbationWorstDecay: 0.1,
      sampleResults: {
        train: { totalReturn: 0.2 }, validation: { totalReturn: 0.1 },
        lockedTest: { totalReturn: -0.01 }, walkForward: [{ totalReturn: 0.02 }],
      },
    });
    expect(result.status).toBe('rejected');
    expect(result.checks).toContainEqual(expect.objectContaining({ id: 'locked-test-minimum-return', status: 'failed' }));
  });
});
