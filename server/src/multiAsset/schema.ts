import { z } from 'zod';
import { canonicalHash } from '../experiments/schema.js';
import {
  fundamentalPlanSchema,
  industryPlanSchema,
  optimizerResultSchema,
  optimizerSpecSchema,
  pointInTimeFundamentalEvidenceSchema,
  pointInTimeIndustryEvidenceSchema,
  validateOptimizerResultHash,
} from './extensionSchema.js';
import { mlModelPlanSchema } from './mlModelSchema.js';
import { validatePortfolioOptimizerResult } from './portfolioOptimizer.js';

const dateSchema = z.iso.date();
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const instrumentKeySchema = z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9_.:-]+$/);

export const factorPlanSchema = z.strictObject({
  protocolVersion: z.literal('1.0'),
  weighting: z.enum(['equal', 'manual', 'training_ic', 'training_rank_ic']),
  trainedThrough: dateSchema.optional(),
  validationStartsAt: dateSchema.optional(),
  factors: z.array(z.strictObject({
    factorId: z.string().trim().min(1).max(128),
    factorVersion: z.string().trim().min(1).max(96),
    direction: z.enum(['higher', 'lower']),
    missing: z.enum(['exclude', 'cross_sectional_median']),
    winsorization: z.strictObject({
      method: z.literal('percentile'),
      lower: z.number().finite().min(0).max(0.49),
      upper: z.number().finite().min(0.51).max(1),
    }).optional(),
    normalization: z.enum(['percentile', 'zscore']),
    weight: z.number().finite(),
  })).min(2).max(32),
});

export const multiAssetPlanSchema = z.strictObject({
  planVersion: z.enum(['1.0', '1.1', '1.2', '1.3']),
  snapshotId: z.string().trim().min(1).max(128),
  snapshotChecksum: hashSchema,
  calendarId: z.string().trim().min(1).max(80),
  universePlan: z.strictObject({
    type: z.literal('point_in_time'),
    datasetId: z.string().trim().min(1).max(128),
    datasetChecksum: hashSchema,
    filterAudit: z.array(z.strictObject({
      decisionDate: dateSchema,
      candidates: z.number().int().nonnegative(),
      eligible: z.number().int().nonnegative(),
      excludedRiskName: z.number().int().nonnegative(),
      excludedHistory: z.number().int().nonnegative(),
      excludedDataIncomplete: z.number().int().nonnegative(),
      excludedSuspended: z.number().int().nonnegative(),
      excludedLiquidity: z.number().int().nonnegative(),
      eligibleUniverseHash: hashSchema,
      exclusions: z.array(z.strictObject({
        instrumentKey: instrumentKeySchema,
        reasonCodes: z.array(z.enum([
          'risk_name', 'insufficient_history', 'incomplete_bars', 'suspended', 'insufficient_liquidity',
        ])).min(1).max(5),
      })).max(20_000),
    })).max(530).optional(),
  }),
  featurePlan: z.strictObject({
    featureId: z.string().trim().min(1).max(128),
    featureVersion: z.string().trim().min(1).max(64),
    direction: z.enum(['higher', 'lower']),
    missing: z.literal('exclude'),
  }),
  factorPlan: factorPlanSchema.optional(),
  mlModelPlan: mlModelPlanSchema.optional(),
  fundamentalPlan: fundamentalPlanSchema.optional(),
  industryPlan: industryPlanSchema.optional(),
  optimizerSpec: optimizerSpecSchema.optional(),
  signalPlan: z.strictObject({
    type: z.literal('cross_sectional_rank'),
    topN: z.number().int().min(1).max(2_000),
    weighting: z.enum(['equal', 'score']),
  }),
  rebalancePolicy: z.strictObject({
    frequency: z.enum(['weekly', 'monthly']),
    signalAt: z.literal('close'),
    fillAt: z.literal('next_open'),
  }),
  portfolioPlan: z.strictObject({
    maxGrossExposure: z.number().finite().positive().max(1),
    maxSingleWeight: z.number().finite().positive().max(1),
    minCashWeight: z.number().finite().min(0).max(1),
    lotSize: z.number().int().positive().max(100_000),
  }),
  executionPlan: z.strictObject({
    commissionRate: z.number().finite().min(0).max(0.1),
    minimumCommission: z.number().finite().min(0).max(10_000),
    sellTaxRate: z.number().finite().min(0).max(0.1),
    slippageRate: z.number().finite().min(0).max(0.1),
  }),
  governancePlan: z.strictObject({
    factorVersionId: z.string().trim().min(1).max(96).optional(),
    strategyVersionId: z.string().uuid().optional(),
    role: z.enum(['research', 'challenger', 'champion']),
  }).optional(),
}).superRefine((plan, context) => {
  if (plan.planVersion === '1.1' && !plan.factorPlan) {
    context.addIssue({ code: 'custom', path: ['factorPlan'], message: 'PLAN_1_1_FACTOR_PLAN_REQUIRED' });
  }
  if (plan.planVersion === '1.2' && !plan.factorPlan && !plan.optimizerSpec && !plan.fundamentalPlan && !plan.industryPlan) {
    context.addIssue({ code: 'custom', path: ['planVersion'], message: 'PLAN_1_2_EXTENSION_REQUIRED' });
  }
  if (plan.factorPlan) {
    const ids = plan.factorPlan.factors.map((factor) => factor.factorId);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: 'custom', path: ['factorPlan', 'factors'], message: 'DUPLICATE_FACTOR_ID' });
    }
    if (plan.factorPlan.weighting.startsWith('training_')) {
      if (!plan.factorPlan.trainedThrough || !plan.factorPlan.validationStartsAt
        || plan.factorPlan.trainedThrough >= plan.factorPlan.validationStartsAt) {
        context.addIssue({ code: 'custom', path: ['factorPlan'], message: 'TRAINING_WEIGHTS_MUST_PRECEDE_VALIDATION' });
      }
    }
  }
  if (plan.mlModelPlan) {
    if (!plan.factorPlan) {
      context.addIssue({ code: 'custom', path: ['mlModelPlan'], message: 'ML_MODEL_REQUIRES_FACTOR_PLAN' });
    } else {
      const factorIds = new Set(plan.factorPlan.factors.map((factor) => factor.factorId));
      for (const feature of plan.mlModelPlan.features) {
        if (!factorIds.has(feature)) {
          context.addIssue({ code: 'custom', path: ['mlModelPlan', 'features'], message: `ML_FEATURE_NOT_IN_FACTOR_PLAN:${feature}` });
        }
      }
      if (plan.mlModelPlan.validationStartsAt
        && (!plan.factorPlan.validationStartsAt
          || plan.mlModelPlan.validationStartsAt !== plan.factorPlan.validationStartsAt)) {
        context.addIssue({ code: 'custom', path: ['mlModelPlan', 'validationStartsAt'], message: 'ML_VALIDATION_BOUNDARY_MISMATCH' });
      }
    }
  }
  if (plan.optimizerSpec?.industryNeutral && !plan.industryPlan) {
    context.addIssue({ code: 'custom', path: ['industryPlan'], message: 'INDUSTRY_PLAN_REQUIRED' });
  }
  if (plan.fundamentalPlan) {
    const configured = new Set(plan.factorPlan?.factors.map((factor) => factor.factorId) ?? []);
    for (const field of plan.fundamentalPlan.fields) {
      if (!configured.has(field)) {
        context.addIssue({ code: 'custom', path: ['fundamentalPlan', 'fields'], message: `FUNDAMENTAL_FACTOR_NOT_CONFIGURED:${field}` });
      }
    }
  }
});

const targetSchema = z.strictObject({
  instrumentKey: instrumentKeySchema,
  rank: z.number().int().positive(),
  score: z.number().finite(),
  targetWeight: z.number().finite().min(0).max(1),
  reasonCodes: z.array(z.string().trim().min(1).max(80)).max(40),
});

const rebalanceDecisionSchema = z.strictObject({
  decisionDate: dateSchema,
  executableFrom: dateSchema,
  eligibleUniverse: z.array(instrumentKeySchema).min(1).max(20_000),
  universeHash: hashSchema,
  featureEvidence: z.array(z.strictObject({
    instrumentKey: instrumentKeySchema,
    featureValue: z.number().finite().nullable(),
    factorValues: z.record(z.string(), z.number().finite().nullable()).optional(),
    normalizedFactors: z.record(z.string(), z.number().finite()).optional(),
    compositeScore: z.number().finite().optional(),
    evidenceHash: hashSchema.optional(),
    fundamentalEvidence: pointInTimeFundamentalEvidenceSchema.optional(),
    industryEvidence: pointInTimeIndustryEvidenceSchema.optional(),
  })).min(1).max(20_000),
  featureHash: hashSchema,
  targets: z.array(targetSchema).max(2_000),
  optimizerResult: optimizerResultSchema.optional(),
});

export const rebalancePlanSchema = z.strictObject({
  protocolVersion: z.enum(['1.0', '1.1', '1.2', '1.3']),
  snapshotId: z.string().trim().min(1).max(128),
  featureEngineVersion: z.string().trim().min(1).max(128),
  sourcePlanHash: hashSchema,
  planHash: hashSchema,
  decisions: z.array(rebalanceDecisionSchema).min(1).max(5_000),
});

export const pointInTimeFeatureRowSchema = z.strictObject({
  decisionDate: dateSchema,
  executableFrom: dateSchema,
  instrumentKey: instrumentKeySchema,
  memberFrom: dateSchema,
  memberTo: dateSchema.nullable(),
  featureValue: z.number().finite().nullable(),
  factorValues: z.record(z.string(), z.number().finite().nullable()).optional(),
  riskProxy: z.number().finite().nonnegative().optional(),
  fundamentalEvidence: pointInTimeFundamentalEvidenceSchema.optional(),
  industryEvidence: pointInTimeIndustryEvidenceSchema.optional(),
});

export type MultiAssetPlan = z.infer<typeof multiAssetPlanSchema>;
export type RebalancePlan = z.infer<typeof rebalancePlanSchema>;
export type PointInTimeFeatureRow = z.infer<typeof pointInTimeFeatureRowSchema>;

export function hashMultiAssetPlan(plan: MultiAssetPlan): string {
  const parsed = multiAssetPlanSchema.parse(plan);
  return canonicalHash(parsed.factorPlan ? {
    ...parsed,
    factorPlan: {
      ...parsed.factorPlan,
      factors: [...parsed.factorPlan.factors]
        .sort((left, right) => left.factorId.localeCompare(right.factorId)),
    },
  } : parsed);
}

export function hashRebalancePlan(plan: Omit<RebalancePlan, 'planHash'>): string {
  return canonicalHash(plan);
}

export function finalizeRebalancePlan(plan: Omit<RebalancePlan, 'planHash'>): RebalancePlan {
  return rebalancePlanSchema.parse({ ...plan, planHash: hashRebalancePlan(plan) });
}

export function validateRebalancePlan(
  rawPlan: unknown,
  rawSourcePlan: unknown,
): RebalancePlan {
  const sourcePlan = multiAssetPlanSchema.parse(rawSourcePlan);
  const plan = rebalancePlanSchema.parse(rawPlan);
  const { planHash, ...hashable } = plan;
  if (planHash !== hashRebalancePlan(hashable)) throw new Error('REBALANCE_PLAN_HASH_MISMATCH');
  if (plan.sourcePlanHash !== hashMultiAssetPlan(sourcePlan)) throw new Error('SOURCE_PLAN_HASH_MISMATCH');
  if (plan.snapshotId !== sourcePlan.snapshotId) throw new Error('SNAPSHOT_MISMATCH');

  let previousDate = '';
  for (const decision of plan.decisions) {
    if (decision.decisionDate <= previousDate) throw new Error('DECISION_DATES_NOT_STRICTLY_ASCENDING');
    if (decision.executableFrom <= decision.decisionDate) throw new Error('EXECUTION_NOT_AFTER_DECISION');
    previousDate = decision.decisionDate;
    const universe = [...decision.eligibleUniverse].sort();
    if (new Set(universe).size !== universe.length) throw new Error('DUPLICATE_UNIVERSE_MEMBER');
    if (decision.universeHash !== canonicalHash({
      decisionDate: decision.decisionDate,
      members: universe,
    })) throw new Error('UNIVERSE_HASH_MISMATCH');
    const evidence = [...decision.featureEvidence]
      .sort((left, right) => left.instrumentKey.localeCompare(right.instrumentKey));
    if (new Set(evidence.map((item) => item.instrumentKey)).size !== evidence.length) {
      throw new Error('DUPLICATE_FEATURE_EVIDENCE');
    }
    if (evidence.some((item) => !universe.includes(item.instrumentKey))) {
      throw new Error('FEATURE_EVIDENCE_OUTSIDE_UNIVERSE');
    }
    if (decision.featureHash !== canonicalHash(evidence)) throw new Error('FEATURE_HASH_MISMATCH');
    const targetKeys = new Set<string>();
    let weightSum = 0;
    for (const target of decision.targets) {
      if (!universe.includes(target.instrumentKey)) throw new Error('TARGET_OUTSIDE_POINT_IN_TIME_UNIVERSE');
      if (targetKeys.has(target.instrumentKey)) throw new Error('DUPLICATE_TARGET');
      targetKeys.add(target.instrumentKey);
      if (target.targetWeight > sourcePlan.portfolioPlan.maxSingleWeight + 1e-12) {
        throw new Error('TARGET_EXCEEDS_SINGLE_WEIGHT_LIMIT');
      }
      weightSum += target.targetWeight;
    }
    const allowedGross = Math.min(
      sourcePlan.portfolioPlan.maxGrossExposure,
      1 - sourcePlan.portfolioPlan.minCashWeight,
    );
    if (weightSum > allowedGross + 1e-9) throw new Error('TARGET_WEIGHTS_EXCEED_GROSS_LIMIT');
    if (decision.optimizerResult) {
      if (!sourcePlan.optimizerSpec) throw new Error('OPTIMIZER_RESULT_WITHOUT_SPEC');
      const optimizerResult = validateOptimizerResultHash(decision.optimizerResult);
      validatePortfolioOptimizerResult(optimizerResult, sourcePlan.optimizerSpec, {
        grossExposure: sourcePlan.portfolioPlan.maxGrossExposure,
        maxSingleWeight: sourcePlan.portfolioPlan.maxSingleWeight,
        minCashWeight: sourcePlan.portfolioPlan.minCashWeight,
      });
      const optimized = new Map(optimizerResult.weights.map((item) => [item.instrumentKey, item.optimizedWeight]));
      for (const target of decision.targets) {
        if (Math.abs((optimized.get(target.instrumentKey) ?? -1) - target.targetWeight) > sourcePlan.optimizerSpec.solver.tolerance) {
          throw new Error('TARGET_WEIGHT_DIFFERS_FROM_OPTIMIZER_RESULT');
        }
      }
    }
  }
  return plan;
}
