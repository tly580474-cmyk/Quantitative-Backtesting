import { z } from 'zod';
import { canonicalHash } from '../experiments/schema.js';

const dateSchema = z.iso.date();
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const instrumentKeySchema = z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9_.:-]+$/);

export const multiAssetPlanSchema = z.strictObject({
  planVersion: z.literal('1.0'),
  snapshotId: z.string().trim().min(1).max(128),
  snapshotChecksum: hashSchema,
  calendarId: z.string().trim().min(1).max(80),
  universePlan: z.strictObject({
    type: z.literal('point_in_time'),
    datasetId: z.string().trim().min(1).max(128),
    datasetChecksum: hashSchema,
  }),
  featurePlan: z.strictObject({
    featureId: z.string().trim().min(1).max(128),
    featureVersion: z.string().trim().min(1).max(64),
    direction: z.enum(['higher', 'lower']),
    missing: z.literal('exclude'),
  }),
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
});

const targetSchema = z.strictObject({
  instrumentKey: instrumentKeySchema,
  rank: z.number().int().positive(),
  score: z.number().finite(),
  targetWeight: z.number().finite().min(0).max(1),
  reasonCodes: z.array(z.string().trim().min(1).max(80)).max(20),
});

const rebalanceDecisionSchema = z.strictObject({
  decisionDate: dateSchema,
  executableFrom: dateSchema,
  eligibleUniverse: z.array(instrumentKeySchema).min(1).max(20_000),
  universeHash: hashSchema,
  featureEvidence: z.array(z.strictObject({
    instrumentKey: instrumentKeySchema,
    featureValue: z.number().finite().nullable(),
  })).min(1).max(20_000),
  featureHash: hashSchema,
  targets: z.array(targetSchema).max(2_000),
});

export const rebalancePlanSchema = z.strictObject({
  protocolVersion: z.literal('1.0'),
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
});

export type MultiAssetPlan = z.infer<typeof multiAssetPlanSchema>;
export type RebalancePlan = z.infer<typeof rebalancePlanSchema>;
export type PointInTimeFeatureRow = z.infer<typeof pointInTimeFeatureRowSchema>;

export function hashMultiAssetPlan(plan: MultiAssetPlan): string {
  return canonicalHash(multiAssetPlanSchema.parse(plan));
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
    if (weightSum > allowedGross + 1e-10) throw new Error('TARGET_WEIGHTS_EXCEED_GROSS_LIMIT');
  }
  return plan;
}
