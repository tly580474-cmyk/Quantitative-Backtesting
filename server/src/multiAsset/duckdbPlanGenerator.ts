import { canonicalHash } from '../experiments/schema.js';
import { openManagedDuckDB } from '../research/duckdbRuntime.js';
import {
  finalizeRebalancePlan,
  hashMultiAssetPlan,
  multiAssetPlanSchema,
  pointInTimeFeatureRowSchema,
  validateRebalancePlan,
  type MultiAssetPlan,
  type PointInTimeFeatureRow,
  type RebalancePlan,
} from './schema.js';

export const DUCKDB_FEATURE_ENGINE_VERSION = 'duckdb-cross-sectional-v1';

interface RankedRow {
  decisionDate: string;
  executableFrom: string;
  instrumentKey: string;
  featureValue: number;
  rank: number;
}

export async function generateRebalancePlan(
  rawPlan: unknown,
  rawRows: unknown[],
): Promise<RebalancePlan> {
  const plan = multiAssetPlanSchema.parse(rawPlan);
  const rows = rawRows.map((row) => pointInTimeFeatureRowSchema.parse(row));
  if (rows.length === 0) throw new Error('POINT_IN_TIME_FEATURE_ROWS_REQUIRED');
  const ranked = await rankWithDuckDB(plan, rows);
  if (ranked.length === 0) throw new Error('NO_ELIGIBLE_POINT_IN_TIME_FEATURE_ROWS');

  const decisions = [...new Set(ranked.map((row) => row.decisionDate))].sort().map((decisionDate) => {
    const sourceForDate = rows.filter((row) => row.decisionDate === decisionDate && isMemberAt(row, decisionDate));
    const eligibleUniverse = [...new Set(sourceForDate.map((row) => row.instrumentKey))].sort();
    const featureEvidence = sourceForDate
      .map(({ instrumentKey, featureValue }) => ({ instrumentKey, featureValue }))
      .sort((left, right) => left.instrumentKey.localeCompare(right.instrumentKey));
    const selected = ranked.filter((row) => row.decisionDate === decisionDate);
    const weights = targetWeights(plan, selected);
    return {
      decisionDate,
      executableFrom: selected[0].executableFrom,
      eligibleUniverse,
      universeHash: canonicalHash({ decisionDate, members: eligibleUniverse }),
      featureEvidence,
      featureHash: canonicalHash(featureEvidence),
      targets: selected.map((row, index) => ({
        instrumentKey: row.instrumentKey,
        rank: row.rank,
        score: row.featureValue,
        targetWeight: weights[index],
        reasonCodes: [`${plan.featurePlan.featureId}@${plan.featurePlan.featureVersion}`, `rank:${row.rank}`],
      })),
    };
  });
  const output = finalizeRebalancePlan({
    protocolVersion: '1.0',
    snapshotId: plan.snapshotId,
    featureEngineVersion: DUCKDB_FEATURE_ENGINE_VERSION,
    sourcePlanHash: hashMultiAssetPlan(plan),
    decisions,
  });
  return validateRebalancePlan(output, plan);
}

async function rankWithDuckDB(plan: MultiAssetPlan, rows: PointInTimeFeatureRow[]): Promise<RankedRow[]> {
  const values = rows.map((row) => `(
    DATE '${row.decisionDate}', DATE '${row.executableFrom}', '${row.instrumentKey}',
    DATE '${row.memberFrom}', ${row.memberTo ? `DATE '${row.memberTo}'` : 'NULL'},
    ${row.featureValue === null ? 'NULL' : row.featureValue}
  )`).join(',');
  const direction = plan.featurePlan.direction === 'higher' ? 'DESC' : 'ASC';
  const period = plan.rebalancePolicy.frequency === 'weekly'
    ? "strftime(decision_date, '%G-%V')"
    : "strftime(decision_date, '%Y-%m')";
  const session = await openManagedDuckDB({ label: 'multi-asset-plan', config: { threads: '2' } });
  try {
    const reader = await session.connection.runAndReadAll(`
      WITH source(decision_date, executable_from, instrument_key, member_from, member_to, feature_value) AS (
        VALUES ${values}
      ), eligible AS (
        SELECT * FROM source
        WHERE member_from <= decision_date
          AND (member_to IS NULL OR member_to >= decision_date)
          AND feature_value IS NOT NULL
      ), selected_dates AS (
        SELECT max(decision_date) AS decision_date
        FROM eligible GROUP BY ${period}
      ), ranked AS (
        SELECT e.*,
          row_number() OVER (
            PARTITION BY e.decision_date
            ORDER BY e.feature_value ${direction}, e.instrument_key ASC
          ) AS rank
        FROM eligible e JOIN selected_dates d USING (decision_date)
      )
      SELECT decision_date, executable_from, instrument_key, feature_value, rank
      FROM ranked WHERE rank <= ${plan.signalPlan.topN}
      ORDER BY decision_date, rank
    `);
    return reader.getRowObjectsJson().map((row) => ({
      decisionDate: String(row.decision_date),
      executableFrom: String(row.executable_from),
      instrumentKey: String(row.instrument_key),
      featureValue: Number(row.feature_value),
      rank: Number(row.rank),
    }));
  } finally {
    await session.close();
  }
}

function targetWeights(plan: MultiAssetPlan, selected: RankedRow[]): number[] {
  const gross = Math.min(plan.portfolioPlan.maxGrossExposure, 1 - plan.portfolioPlan.minCashWeight);
  if (plan.signalPlan.weighting === 'equal') {
    const weight = Math.min(gross / selected.length, plan.portfolioPlan.maxSingleWeight);
    return selected.map(() => weight);
  }
  const values = selected.map((row) => plan.featurePlan.direction === 'higher'
    ? row.featureValue : -row.featureValue);
  const floor = Math.min(...values);
  const strengths = values.map((value) => value - floor + 1e-12);
  const total = strengths.reduce((sum, value) => sum + value, 0);
  const preliminary = strengths.map((value) => gross * value / total);
  return capAndRedistribute(preliminary, plan.portfolioPlan.maxSingleWeight, gross);
}

function capAndRedistribute(weights: number[], cap: number, gross: number): number[] {
  const output = weights.map(() => 0);
  const open = new Set(weights.map((_, index) => index));
  let remaining = gross;
  while (open.size > 0 && remaining > 1e-12) {
    const sourceTotal = [...open].reduce((sum, index) => sum + weights[index], 0);
    let capped = false;
    for (const index of [...open]) {
      const proposed = sourceTotal > 0 ? remaining * weights[index] / sourceTotal : remaining / open.size;
      if (proposed >= cap - 1e-12) {
        output[index] = cap;
        remaining -= cap;
        open.delete(index);
        capped = true;
      }
    }
    if (!capped) {
      for (const index of open) output[index] = sourceTotal > 0
        ? remaining * weights[index] / sourceTotal : remaining / open.size;
      break;
    }
  }
  return output;
}

function isMemberAt(row: PointInTimeFeatureRow, date: string): boolean {
  return row.memberFrom <= date && (row.memberTo === null || row.memberTo >= date);
}
