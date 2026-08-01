import { describe, expect, it } from 'vitest';
import { solvePortfolioOptimizer, validatePortfolioOptimizerResult } from './portfolioOptimizer.js';
import {
  finalizeMultiAssetExtensionReport,
  multiAssetExtensionReportSchema,
  validateOptimizerResultHash,
} from './extensionSchema.js';

const spec = {
  protocolVersion: '1.0' as const,
  objective: 'expected_return_minus_risk_and_turnover' as const,
  mode: 'constrained' as const,
  riskAversion: 0.2,
  turnoverPenalty: 0.1,
  maxTurnover: 0.8,
  maxHoldings: 4,
  solver: { name: 'deterministic_projection' as const, version: '1.0' as const, tolerance: 1e-9, maxIterations: 200, seed: 7 },
};
const limits = { grossExposure: 0.8, maxSingleWeight: 0.3, minCashWeight: 0.2 };
const candidates = [
  { instrumentKey: '1', expectedReturn: 0.09, riskProxy: 0.20, previousWeight: 0.2, industryCode: 'A' },
  { instrumentKey: '2', expectedReturn: 0.08, riskProxy: 0.18, previousWeight: 0.2, industryCode: 'A' },
  { instrumentKey: '3', expectedReturn: 0.07, riskProxy: 0.12, previousWeight: 0.2, industryCode: 'B' },
  { instrumentKey: '4', expectedReturn: 0.05, riskProxy: 0.10, previousWeight: 0.2, industryCode: 'B' },
];

describe('M4 deterministic portfolio optimizer', () => {
  it('is deterministic and independently validates every hard constraint', () => {
    const first = solvePortfolioOptimizer({ decisionDate: '2026-06-30', candidates, spec, limits });
    const second = solvePortfolioOptimizer({ decisionDate: '2026-06-30', candidates, spec, limits });
    expect(first).toEqual(second);
    expect(first.status).toBe('solved');
    expect(first.grossExposure).toBeCloseTo(0.8, 8);
    validatePortfolioOptimizerResult(first, spec, limits);
  });

  it('returns an explicit infeasible result instead of silently falling back', () => {
    const result = solvePortfolioOptimizer({
      decisionDate: '2026-06-30', candidates: candidates.slice(0, 2), spec,
      limits: { ...limits, maxSingleWeight: 0.1 },
    });
    expect(result.status).toBe('infeasible');
    expect(result.conflicts).toContain('HOLDING_CAP_CANNOT_REACH_GROSS');
    expect(result.weights).toEqual([]);
  });

  it('enforces a non-zero minimum position weight or reports it as infeasible', () => {
    const result = solvePortfolioOptimizer({
      decisionDate: '2026-06-30', candidates,
      spec: { ...spec, minPositionWeight: 0.15 }, limits,
    });
    expect(result.status).toBe('solved');
    expect(result.weights.every((item) => item.optimizedWeight >= 0.15 - spec.solver.tolerance)).toBe(true);

    const impossible = solvePortfolioOptimizer({
      decisionDate: '2026-06-30', candidates,
      spec: { ...spec, minPositionWeight: 0.25 }, limits,
    });
    expect(impossible.status).toBe('infeasible');
    expect(impossible.conflicts).toContain('MINIMUM_POSITION_WEIGHT_EXCEEDS_GROSS');
  });

  it('enforces industry neutrality and rejects unknown industries by default', () => {
    const neutralSpec = {
      ...spec,
      industryNeutral: {
        protocolVersion: '1.0' as const, taxonomy: 'SW2021' as const, level: 1 as const,
        benchmark: 'universe_equal' as const, maxActiveDeviation: 0.02, allowUnknown: false,
      },
    };
    const result = solvePortfolioOptimizer({ decisionDate: '2026-06-30', candidates, spec: neutralSpec, limits });
    expect(result.status).toBe('solved');
    expect(result.constraintMargins.industryDeviation).toBeGreaterThanOrEqual(-1e-9);
    const rejected = solvePortfolioOptimizer({
      decisionDate: '2026-06-30', candidates: [{ ...candidates[0], industryCode: null }],
      spec: neutralSpec, limits: { ...limits, grossExposure: 0.2, minCashWeight: 0.8 },
    });
    expect(rejected.conflicts).toContain('UNKNOWN_INDUSTRY_NOT_ALLOWED');
  });

  it('enforces optional absolute industry bounds and reports conflicting bounds', () => {
    const boundedSpec = {
      ...spec,
      industryNeutral: {
        protocolVersion: '1.0' as const, taxonomy: 'SW2021' as const, level: 1 as const,
        benchmark: 'universe_equal' as const, maxActiveDeviation: 0.2, allowUnknown: false,
        absoluteBounds: { A: { min: 0.45, max: 0.55 }, B: { min: 0.25, max: 0.35 } },
      },
    };
    const result = solvePortfolioOptimizer({ decisionDate: '2026-06-30', candidates, spec: boundedSpec, limits });
    expect(result.status).toBe('solved');
    expect(result.industryExposure?.A).toBeGreaterThanOrEqual(0.45 - 1e-9);
    expect(result.industryExposure?.B).toBeLessThanOrEqual(0.35 + 1e-9);
    validatePortfolioOptimizerResult(result, boundedSpec, limits);

    const conflicting = solvePortfolioOptimizer({
      decisionDate: '2026-06-30', candidates,
      spec: {
        ...boundedSpec,
        industryNeutral: { ...boundedSpec.industryNeutral, absoluteBounds: { A: { min: 0.7 } } },
      },
      limits,
    });
    expect(conflicting.status).toBe('infeasible');
    expect(conflicting.conflicts).toContain('INDUSTRY_BOUND_CONFLICT:A');
  });

  it('detects result tampering and keeps small score perturbations bounded', () => {
    const result = solvePortfolioOptimizer({ decisionDate: '2026-06-30', candidates, spec, limits });
    expect(() => validateOptimizerResultHash({
      ...result,
      weights: result.weights.map((item, index) => index === 0
        ? { ...item, optimizedWeight: item.optimizedWeight + 0.01 }
        : item),
    })).toThrow('OPTIMIZER_RESULT_HASH_MISMATCH');

    const perturbed = solvePortfolioOptimizer({
      decisionDate: '2026-06-30',
      candidates: candidates.map((candidate, index) => ({
        ...candidate,
        expectedReturn: candidate.expectedReturn + (index % 2 === 0 ? 1e-5 : -1e-5),
      })),
      spec,
      limits,
    });
    const changed = result.weights.reduce((total, item, index) => (
      total + Math.abs(item.optimizedWeight - perturbed.weights[index].optimizedWeight)
    ), 0);
    expect(changed).toBeLessThan(0.01);
  });

  it('does not increase turnover when the turnover penalty is raised', () => {
    const lowPenalty = solvePortfolioOptimizer({
      decisionDate: '2026-06-30', candidates,
      spec: { ...spec, turnoverPenalty: 0, maxTurnover: 2 }, limits,
    });
    const highPenalty = solvePortfolioOptimizer({
      decisionDate: '2026-06-30', candidates,
      spec: { ...spec, turnoverPenalty: 10, maxTurnover: 2 }, limits,
    });
    expect(highPenalty.turnover).toBeLessThanOrEqual(lowPenalty.turnover + spec.solver.tolerance);
  });

  it('produces a strict, hash-bound operational extension report', () => {
    const report = finalizeMultiAssetExtensionReport({
      protocolVersion: '1.0', runId: '11111111-1111-4111-8111-111111111111',
      sourcePlanHash: 'a'.repeat(64), rebalancePlanHash: 'b'.repeat(64), pythonPlanHash: 'c'.repeat(64),
      metrics: {
        factorCount: 4, averageUniverseSize: 300, maximumUniverseSize: 300,
        optimizerDecisionCount: 12, optimizerPlanningDurationMs: 42,
        totalDurationMs: 120, peakRssBytes: 256_000_000, infeasibleRate: 0,
        maximumIndustryDeviation: 0.018, averageTurnover: 0.22,
      },
      generatedAt: '2026-08-01T00:00:00.000Z',
    });
    expect(multiAssetExtensionReportSchema.parse(report)).toEqual(report);
    expect(() => multiAssetExtensionReportSchema.parse({ ...report, metrics: { ...report.metrics, factorCount: -1 } }))
      .toThrow();
  });
});
