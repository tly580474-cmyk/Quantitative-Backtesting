import { describe, expect, it } from 'vitest';
import {
  evaluateStrategyPromotion,
  isQuarterlyChallengerDue,
  validateCompositeWeights,
} from './strategyGovernance.js';

const passing = {
  paperRebalanceCycles: 6,
  annualExcessEligibleUniverse: 0.04,
  annualExcessCsi500: 0.05,
  informationRatioEligibleUniverse: 0.7,
  informationRatioCsi500: 0.6,
  maxDrawdown: -0.20,
  stressedCostCumulativeReturn: 0.03,
  positiveHistoricalRegimes: 3,
  historicalRegimeCount: 4,
  paperCumulativeExcessEligibleUniverse: 0.01,
  paperCumulativeExcessCsi500: 0.02,
  violations: [],
};

describe('strategy governance', () => {
  it('requires every paper and dual-benchmark promotion gate', () => {
    expect(evaluateStrategyPromotion(passing).passed).toBe(true);
    const result = evaluateStrategyPromotion({ ...passing, paperRebalanceCycles: 5,
      annualExcessCsi500: 0.01, violations: ['optimizer_failed'] });
    expect(result.passed).toBe(false);
    expect(result.failures).toHaveLength(3);
  });

  it('enforces non-negative shrunk factor and family caps', () => {
    expect(() => validateCompositeWeights([
      { versionId: 'a', family: 'quality', weight: 0.2 },
      { versionId: 'b', family: 'quality', weight: 0.2 },
      { versionId: 'c', family: 'value', weight: 0.2 },
      { versionId: 'd', family: 'cashflow', weight: 0.2 },
      { versionId: 'e', family: 'momentum', weight: 0.2 },
    ])).not.toThrow();
  });

  it('creates at most one scheduled challenger per UTC quarter', () => {
    expect(isQuarterlyChallengerDue('2026-04-01T00:00:00Z',
      new Date('2026-06-30T00:00:00Z'))).toBe(false);
    expect(isQuarterlyChallengerDue('2026-04-01T00:00:00Z',
      new Date('2026-07-01T00:00:00Z'))).toBe(true);
  });
});
