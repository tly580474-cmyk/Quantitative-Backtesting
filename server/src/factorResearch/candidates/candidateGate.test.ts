import { describe, expect, it } from 'vitest';
import { evaluateCandidateReleaseGate } from './candidateGate.js';

describe('candidate release metrics gate', () => {
  it('passes a sufficiently broad and stable locked test', () => {
    expect(evaluateCandidateReleaseGate({ sampleCount: 5000, tradingDays: 120,
      averageRankIc: 0.035, rankIcPositiveRate: 0.62, longShortSpread: 0.01,
      portfolio: { stressedCostSharpe: 1.2 }, robustness: { coverageRate: 0.95 },
      maxPublishedFactorCorrelation: 0.4, marginalInformationIc: 0.018 },
      { deflated_sharpe_probability: 0.98 }).passed).toBe(true);
  });

  it('reports every failed hard threshold', () => {
    const result = evaluateCandidateReleaseGate({ sampleCount: 10, tradingDays: 5,
      averageRankIc: 0.001, rankIcPositiveRate: 0.2, longShortSpread: -0.01 });
    expect(result.passed).toBe(false);
    expect(result.failures).toHaveLength(10);
  });

  it('does not coerce missing locked-test metrics to zero', () => {
    const result = evaluateCandidateReleaseGate({
      sampleCount: null, tradingDays: null, averageRankIc: null,
      rankIcPositiveRate: null, longShortSpread: null,
      portfolio: { stressedCostSharpe: null }, robustness: { coverageRate: null },
      maxPublishedFactorCorrelation: null, marginalInformationIc: null,
    }, { deflated_sharpe_probability: null });
    expect(result.passed).toBe(false);
    expect(result.failures).toHaveLength(10);
  });
});
