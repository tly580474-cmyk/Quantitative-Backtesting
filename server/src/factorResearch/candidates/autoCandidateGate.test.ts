import { describe, expect, it } from 'vitest';
import { evaluateAutoCandidateGate } from './autoCandidateGate.js';

const validation = {
  oos_decay: 0.10,
  test_rankic: 0.08,
  icir: 0.8,
  ic_t: 2.8,
  deflated_sharpe_probability: 0.97,
};
const locked = {
  averageRankIc: 0.06,
  portfolio: { stressedCostSharpe: 0.4 },
  robustness: { coverageRate: 0.92, liquidityExposure: 0.12 },
  maxPublishedFactorCorrelation: 0.45,
};

describe('automatic candidate gate', () => {
  it('keeps a candidate that passes every automatic rejection rule', () => {
    expect(evaluateAutoCandidateGate(validation, locked)).toEqual({ passed: true, failures: [] });
  });

  it('reports every failed rule instead of hiding later failures', () => {
    const result = evaluateAutoCandidateGate(
      { oos_decay: 0.45, test_rankic: 0.08, icir: 0.2, ic_t: 1.1 },
      {
        averageRankIc: -0.01,
        deflatedSharpeProbability: 0.80,
        portfolio: { stressedCostSharpe: -0.1 },
        robustness: { coverageRate: 0.60, liquidityExposure: 0.52 },
        maxPublishedFactorCorrelation: 0.79,
      },
    );
    expect(result.passed).toBe(false);
    expect(result.failures.join('|')).toMatch(/RankIC/);
    expect(result.failures.join('|')).toMatch(/ICIR/);
    expect(result.failures.join('|')).toMatch(/coverage/);
    expect(result.failures.join('|')).toMatch(/Deflated Sharpe/);
    expect(result.failures.join('|')).toMatch(/double-cost/);
  });
});
