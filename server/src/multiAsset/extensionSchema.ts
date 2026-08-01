import { z } from 'zod';
import { canonicalHash } from '../experiments/schema.js';

const dateSchema = z.iso.date();
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const instrumentKeySchema = z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9_.:-]+$/);

export const fundamentalPlanSchema = z.strictObject({
  protocolVersion: z.literal('1.0'),
  datasetId: z.string().trim().min(1).max(128),
  datasetChecksum: hashSchema,
  maxStalenessDays: z.number().int().min(30).max(1_500),
  fields: z.array(z.enum([
    'roe', 'revenue_growth', 'net_profit_growth', 'debt_to_assets',
    'operating_cash_flow_quality', 'gross_margin', 'free_cash_flow_to_enterprise_value',
  ])).min(1).max(7),
});

const industryAbsoluteBoundSchema = z.strictObject({
  min: z.number().finite().min(0).max(1).optional(),
  max: z.number().finite().min(0).max(1).optional(),
}).superRefine((value, context) => {
  if (value.min !== undefined && value.max !== undefined && value.min > value.max) {
    context.addIssue({ code: 'custom', message: 'industry absolute min must not exceed max' });
  }
});

export const industryNeutralSpecSchema = z.strictObject({
  protocolVersion: z.literal('1.0'),
  taxonomy: z.literal('SW2021'),
  level: z.literal(1),
  benchmark: z.enum(['universe_equal', 'index_weight']),
  maxActiveDeviation: z.number().finite().positive().max(0.25),
  allowUnknown: z.boolean().default(false),
  absoluteBounds: z.record(z.string().trim().min(1).max(12), industryAbsoluteBoundSchema).optional(),
});

export const industryPlanSchema = z.strictObject({
  protocolVersion: z.literal('1.0'),
  datasetId: z.string().trim().min(1).max(128),
  datasetChecksum: hashSchema,
  taxonomy: z.literal('SW2021'),
  level: z.literal(1),
});

export const optimizerSpecSchema = z.strictObject({
  protocolVersion: z.literal('1.0'),
  objective: z.literal('expected_return_minus_risk_and_turnover'),
  mode: z.enum(['baseline', 'constrained']),
  riskAversion: z.number().finite().min(0).max(100),
  turnoverPenalty: z.number().finite().min(0).max(100),
  maxTurnover: z.number().finite().positive().max(2),
  maxHoldings: z.number().int().min(1).max(2_000),
  minPositionWeight: z.number().finite().min(0).max(0.25).optional(),
  solver: z.strictObject({
    name: z.literal('deterministic_projection'),
    version: z.literal('1.0'),
    tolerance: z.number().finite().positive().max(0.01),
    maxIterations: z.number().int().min(10).max(10_000),
    seed: z.number().int().min(0).max(2_147_483_647),
  }),
  industryNeutral: industryNeutralSpecSchema.optional(),
});

export const pointInTimeFundamentalEvidenceSchema = z.strictObject({
  reportPeriod: dateSchema.nullable(),
  announcementDate: dateSchema.nullable(),
  sourceVersion: z.string().trim().min(1).max(128).nullable(),
  ageDays: z.number().int().nonnegative().nullable(),
  missingFields: z.array(z.string().trim().min(1).max(80)).max(32),
});

export const pointInTimeIndustryEvidenceSchema = z.strictObject({
  taxonomy: z.literal('SW2021'),
  level1Code: z.string().trim().min(1).max(12).nullable(),
  level1Name: z.string().trim().min(1).max(128).nullable(),
  effectiveFrom: dateSchema.nullable(),
  effectiveTo: dateSchema.nullable(),
  sourceVersion: z.string().trim().min(1).max(128).nullable(),
});

const optimizerWeightSchema = z.strictObject({
  instrumentKey: instrumentKeySchema,
  baselineWeight: z.number().finite().min(0).max(1),
  optimizedWeight: z.number().finite().min(0).max(1),
  previousWeight: z.number().finite().min(0).max(1),
  expectedReturn: z.number().finite(),
  riskProxy: z.number().finite().nonnegative(),
  industryCode: z.string().trim().min(1).max(12).nullable(),
});

export const optimizerResultSchema = z.strictObject({
  protocolVersion: z.literal('1.0'),
  status: z.enum(['solved', 'infeasible', 'timeout', 'numerical']),
  solver: z.strictObject({
    name: z.literal('deterministic_projection'),
    version: z.literal('1.0'),
    iterations: z.number().int().nonnegative(),
    tolerance: z.number().finite().positive(),
    maxIterations: z.number().int().positive(),
    seed: z.number().int().nonnegative(),
  }),
  weights: z.array(optimizerWeightSchema).max(2_000),
  objective: z.strictObject({
    expectedReturn: z.number().finite(),
    riskPenalty: z.number().finite().nonnegative(),
    turnoverPenalty: z.number().finite().nonnegative(),
    value: z.number().finite(),
  }).nullable(),
  comparison: z.strictObject({
    baseline: z.strictObject({
      expectedReturn: z.number().finite(), riskProxy: z.number().finite().nonnegative(),
      turnover: z.number().finite().nonnegative(), concentration: z.number().finite().nonnegative(),
    }),
    optimized: z.strictObject({
      expectedReturn: z.number().finite(), riskProxy: z.number().finite().nonnegative(),
      turnover: z.number().finite().nonnegative(), concentration: z.number().finite().nonnegative(),
    }),
  }).nullable().optional(),
  turnover: z.number().finite().nonnegative(),
  grossExposure: z.number().finite().nonnegative(),
  industryExposure: z.record(z.string(), z.number().finite()).optional(),
  baselineIndustryExposure: z.record(z.string(), z.number().finite()).optional(),
  benchmarkIndustryExposure: z.record(z.string(), z.number().finite()).optional(),
  constraintMargins: z.record(z.string(), z.number().finite()),
  conflicts: z.array(z.string().trim().min(1).max(160)).max(32),
  inputHash: hashSchema,
  resultHash: hashSchema,
});

export type FundamentalPlan = z.infer<typeof fundamentalPlanSchema>;
export type IndustryNeutralSpec = z.infer<typeof industryNeutralSpecSchema>;
export type IndustryPlan = z.infer<typeof industryPlanSchema>;
export type OptimizerSpec = z.infer<typeof optimizerSpecSchema>;
export type OptimizerResult = z.infer<typeof optimizerResultSchema>;
export type PointInTimeFundamentalEvidence = z.infer<typeof pointInTimeFundamentalEvidenceSchema>;
export type PointInTimeIndustryEvidence = z.infer<typeof pointInTimeIndustryEvidenceSchema>;

export const multiAssetExtensionReportSchema = z.strictObject({
  protocolVersion: z.literal('1.0'),
  runId: z.string().uuid(),
  sourcePlanHash: hashSchema,
  rebalancePlanHash: hashSchema,
  pythonPlanHash: hashSchema,
  metrics: z.strictObject({
    factorCount: z.number().int().nonnegative(),
    averageUniverseSize: z.number().finite().nonnegative(),
    maximumUniverseSize: z.number().int().nonnegative(),
    optimizerDecisionCount: z.number().int().nonnegative(),
    optimizerPlanningDurationMs: z.number().finite().nonnegative(),
    totalDurationMs: z.number().finite().nonnegative(),
    peakRssBytes: z.number().int().nonnegative(),
    infeasibleRate: z.number().finite().min(0).max(1),
    maximumIndustryDeviation: z.number().finite().nonnegative(),
    averageTurnover: z.number().finite().nonnegative(),
  }),
  generatedAt: z.iso.datetime(),
  reportHash: hashSchema,
});

export type MultiAssetExtensionReport = z.infer<typeof multiAssetExtensionReportSchema>;

export function finalizeOptimizerResult(
  result: Omit<OptimizerResult, 'resultHash'>,
): OptimizerResult {
  return optimizerResultSchema.parse({ ...result, resultHash: canonicalHash(result) });
}

export function validateOptimizerResultHash(resultInput: unknown): OptimizerResult {
  const result = optimizerResultSchema.parse(resultInput);
  const { resultHash, ...hashable } = result;
  if (resultHash !== canonicalHash(hashable)) throw new Error('OPTIMIZER_RESULT_HASH_MISMATCH');
  return result;
}

export function finalizeMultiAssetExtensionReport(
  report: Omit<MultiAssetExtensionReport, 'reportHash'>,
): MultiAssetExtensionReport {
  return multiAssetExtensionReportSchema.parse({ ...report, reportHash: canonicalHash(report) });
}
