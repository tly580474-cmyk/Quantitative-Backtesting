import { describe, expect, it } from 'vitest';
import { evaluateAutoCandidateGate } from './autoCandidateGate.js';

const validation = { oos_decay: 0.10, test_rankic: 0.08 };
const locked = {
  averageRankIc: 0.06,
  portfolio: { maxDrawdown: -0.08 },
  robustness: { coverageRate: 0.92, liquidityExposure: 0.12 },
  maxPublishedFactorCorrelation: 0.45,
};

describe('automatic candidate gate', () => {
  it('keeps a candidate that passes every automatic rejection rule', () => {
    expect(evaluateAutoCandidateGate(validation, locked)).toEqual({ passed: true, failures: [] });
  });

  it('reports every failed rule instead of hiding later failures', () => {
    const result = evaluateAutoCandidateGate(
      { oos_decay: 0.45, test_rankic: 0.08 },
      {
        averageRankIc: -0.01,
        portfolio: { maxDrawdown: -0.22 },
        robustness: { coverageRate: 0.60, liquidityExposure: 0.52 },
        maxPublishedFactorCorrelation: 0.79,
      },
    );
    expect(result.passed).toBe(false);
    expect(result.failures.join('|')).toMatch(/过拟合/);
    expect(result.failures.join('|')).toMatch(/回撤过大/);
    expect(result.failures.join('|')).toMatch(/流动性不合格/);
    expect(result.failures.join('|')).toMatch(/正式因子相关性/);
  });
});
