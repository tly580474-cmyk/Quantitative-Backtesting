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
import { solvePortfolioOptimizer } from './portfolioOptimizer.js';

export const DUCKDB_FEATURE_ENGINE_VERSION = 'duckdb-cross-sectional-v1';
export const MULTI_FACTOR_ENGINE_VERSION = 'cross-sectional-composite-v1';

interface RankedRow {
  decisionDate: string;
  executableFrom: string;
  instrumentKey: string;
  featureValue: number;
  rank: number;
  factorValues?: Record<string, number | null>;
  normalizedFactors?: Record<string, number>;
}

export async function generateRebalancePlan(
  rawPlan: unknown,
  rawRows: unknown[],
): Promise<RebalancePlan> {
  const plan = multiAssetPlanSchema.parse(rawPlan);
  const rows = rawRows.map((row) => pointInTimeFeatureRowSchema.parse(row));
  if (rows.length === 0) throw new Error('POINT_IN_TIME_FEATURE_ROWS_REQUIRED');
  const ranked = plan.factorPlan
    ? rankMultiFactor(plan, rows)
    : await rankWithDuckDB(plan, rows);
  if (ranked.length === 0) throw new Error('NO_ELIGIBLE_POINT_IN_TIME_FEATURE_ROWS');

  const previousWeights = new Map<string, number>();
  const decisions = [...new Set(ranked.map((row) => row.decisionDate))].sort().map((decisionDate) => {
    const sourceForDate = rows.filter((row) => row.decisionDate === decisionDate && isMemberAt(row, decisionDate));
    const eligibleUniverse = [...new Set(sourceForDate.map((row) => row.instrumentKey))].sort();
    const rankedForDate = new Map(ranked.filter((row) => row.decisionDate === decisionDate)
      .map((row) => [row.instrumentKey, row]));
    const featureEvidence = sourceForDate
      .map(({ instrumentKey, featureValue, factorValues, fundamentalEvidence, industryEvidence }) => {
        const composite = rankedForDate.get(instrumentKey);
        const evidence = plan.factorPlan ? {
          instrumentKey,
          featureValue: composite?.featureValue ?? null,
          factorValues: Object.fromEntries(Object.entries(factorValues ?? {})
            .map(([factorId, value]) => [factorId, value === 0 ? 0 : value])),
          normalizedFactors: composite?.normalizedFactors,
          compositeScore: composite?.featureValue,
          fundamentalEvidence,
          industryEvidence,
        } : { instrumentKey, featureValue };
        return plan.factorPlan
          ? { ...evidence, evidenceHash: canonicalHash(evidence) }
          : evidence;
      })
      .sort((left, right) => left.instrumentKey.localeCompare(right.instrumentKey));
    const selected = ranked.filter((row) => row.decisionDate === decisionDate
      && (!plan.factorPlan || row.rank <= plan.signalPlan.topN));
    const baselineWeights = targetWeights(plan, selected);
    const sourceByInstrument = new Map(sourceForDate.map((row) => [row.instrumentKey, row]));
    const optimizerResult = plan.optimizerSpec ? solvePortfolioOptimizer({
      decisionDate,
      candidates: selected.map((row) => ({
        instrumentKey: row.instrumentKey,
        expectedReturn: row.featureValue,
        riskProxy: sourceByInstrument.get(row.instrumentKey)?.riskProxy ?? 0,
        previousWeight: previousWeights.get(row.instrumentKey) ?? 0,
        industryCode: sourceByInstrument.get(row.instrumentKey)?.industryEvidence?.level1Code ?? null,
      })),
      spec: plan.optimizerSpec,
      limits: {
        grossExposure: plan.portfolioPlan.maxGrossExposure,
        maxSingleWeight: plan.portfolioPlan.maxSingleWeight,
        minCashWeight: plan.portfolioPlan.minCashWeight,
      },
    }) : undefined;
    if (optimizerResult && optimizerResult.status !== 'solved') {
      throw new Error(`OPTIMIZER_${optimizerResult.status.toUpperCase()}:${optimizerResult.conflicts.join(',')}`);
    }
    const optimizedByInstrument = new Map(optimizerResult?.weights
      .map((item) => [item.instrumentKey, item.optimizedWeight] as const) ?? []);
    const targets = selected.map((row, index) => ({
      instrumentKey: row.instrumentKey,
      rank: row.rank,
      score: row.featureValue,
      targetWeight: optimizedByInstrument.get(row.instrumentKey) ?? baselineWeights[index],
      reasonCodes: plan.factorPlan
        ? [
          ...Object.keys(row.factorValues ?? {}).sort().map((factorId) => {
            const factor = plan.factorPlan!.factors.find((item) => item.factorId === factorId)!;
            return `${factor.factorId}@${factor.factorVersion}`;
          }),
          `rank:${row.rank}`,
        ]
        : [`${plan.featurePlan.featureId}@${plan.featurePlan.featureVersion}`, `rank:${row.rank}`],
    }));
    previousWeights.clear();
    targets.forEach((target) => previousWeights.set(target.instrumentKey, target.targetWeight));
    return {
      decisionDate,
      executableFrom: selected[0].executableFrom,
      eligibleUniverse,
      universeHash: canonicalHash({ decisionDate, members: eligibleUniverse }),
      featureEvidence,
      featureHash: canonicalHash(featureEvidence),
      targets,
      optimizerResult,
    };
  });
  const output = finalizeRebalancePlan({
    protocolVersion: plan.planVersion === '1.2' ? '1.2' : plan.factorPlan ? '1.1' : '1.0',
    snapshotId: plan.snapshotId,
    featureEngineVersion: plan.factorPlan ? MULTI_FACTOR_ENGINE_VERSION : DUCKDB_FEATURE_ENGINE_VERSION,
    sourcePlanHash: hashMultiAssetPlan(plan),
    decisions,
  });
  return validateRebalancePlan(output, plan);
}

function rankMultiFactor(plan: MultiAssetPlan, rows: PointInTimeFeatureRow[]): RankedRow[] {
  const factorPlan = plan.factorPlan!;
  const factors = [...factorPlan.factors].sort((left, right) => left.factorId.localeCompare(right.factorId));
  const rawWeights = factors.map(() => factorPlan.weighting === 'equal' ? 1 : 0)
    .map((value, index) => factorPlan.weighting === 'equal' ? value : factors[index].weight);
  const weightScale = rawWeights.reduce((sum, value) => sum + Math.abs(value), 0);
  if (weightScale <= 0) throw new Error('MULTI_FACTOR_WEIGHT_SUM_ZERO');
  const weights = rawWeights.map((value) => value / weightScale);
  const selectedDates = selectDecisionDates(plan, rows);
  return selectedDates.flatMap((decisionDate) => {
    const source = rows.filter((row) => row.decisionDate === decisionDate && isMemberAt(row, decisionDate));
    const normalizedByFactor = new Map<string, Map<string, number>>();
    for (const factor of factors) {
      const raw = source.map((row) => ({
        instrumentKey: row.instrumentKey,
        value: row.factorValues?.[factor.factorId] ?? null,
      }));
      const available = raw.map((item) => item.value).filter(isFiniteNumber);
      if (available.length === 0) continue;
      const fill = median(available);
      const completed = raw.flatMap((item) => {
        const value = item.value ?? (factor.missing === 'cross_sectional_median' ? fill : null);
        return value === null ? [] : [{ instrumentKey: item.instrumentKey, value }];
      });
      const winsorized = factor.winsorization
        ? winsorize(completed, factor.winsorization.lower, factor.winsorization.upper)
        : completed;
      const directed = winsorized.map((item) => ({
        ...item,
        value: factor.direction === 'higher' ? item.value : -item.value,
      }));
      normalizedByFactor.set(factor.factorId, factor.normalization === 'zscore'
        ? zscore(directed) : percentileRank(directed));
    }
    const scored = source.flatMap((row) => {
      const normalizedFactors: Record<string, number> = {};
      for (const factor of factors) {
        const value = normalizedByFactor.get(factor.factorId)?.get(row.instrumentKey);
        if (value === undefined) return [];
        normalizedFactors[factor.factorId] = value;
      }
      const score = factors.reduce((sum, factor, index) => (
        sum + normalizedFactors[factor.factorId] * weights[index]
      ), 0);
      return [{
        decisionDate,
        executableFrom: row.executableFrom,
        instrumentKey: row.instrumentKey,
        featureValue: roundCrossRuntime(score),
        factorValues: Object.fromEntries(factors.map((factor) => [
          factor.factorId, row.factorValues?.[factor.factorId] ?? null,
        ])),
        normalizedFactors: Object.fromEntries(Object.entries(normalizedFactors)
          .map(([factorId, value]) => [factorId, roundCrossRuntime(value)])),
        rank: 0,
      }];
    }).sort((left, right) => right.featureValue - left.featureValue
      || left.instrumentKey.localeCompare(right.instrumentKey));
    return scored.map((row, index) => ({ ...row, rank: index + 1 }));
  });
}

function selectDecisionDates(plan: MultiAssetPlan, rows: PointInTimeFeatureRow[]): string[] {
  const latest = new Map<string, string>();
  for (const row of rows) {
    const key = plan.rebalancePolicy.frequency === 'monthly'
      ? row.decisionDate.slice(0, 7) : isoWeekKey(row.decisionDate);
    if (!latest.has(key) || latest.get(key)! < row.decisionDate) latest.set(key, row.decisionDate);
  }
  return [...latest.values()].sort();
}

function isoWeekKey(date: string): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  const day = value.getUTCDay() || 7;
  value.setUTCDate(value.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(value.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((value.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7);
  return `${value.getUTCFullYear()}-${String(week).padStart(2, '0')}`;
}

function winsorize(
  values: Array<{ instrumentKey: string; value: number }>,
  lower: number,
  upper: number,
): Array<{ instrumentKey: string; value: number }> {
  const ordered = values.map((item) => item.value).sort((left, right) => left - right);
  const low = quantile(ordered, lower);
  const high = quantile(ordered, upper);
  return values.map((item) => ({ ...item, value: Math.min(high, Math.max(low, item.value)) }));
}

function percentileRank(values: Array<{ instrumentKey: string; value: number }>): Map<string, number> {
  const ordered = [...values].sort((left, right) => left.value - right.value
    || left.instrumentKey.localeCompare(right.instrumentKey));
  const result = new Map<string, number>();
  let start = 0;
  while (start < ordered.length) {
    let end = start;
    while (end + 1 < ordered.length && ordered[end + 1].value === ordered[start].value) end += 1;
    const rank = roundCrossRuntime(ordered.length === 1 ? 0.5 : ((start + end) / 2) / (ordered.length - 1));
    for (let index = start; index <= end; index += 1) result.set(ordered[index].instrumentKey, rank);
    start = end + 1;
  }
  return result;
}

function zscore(values: Array<{ instrumentKey: string; value: number }>): Map<string, number> {
  const mean = values.reduce((sum, item) => sum + item.value, 0) / values.length;
  const variance = values.reduce((sum, item) => sum + (item.value - mean) ** 2, 0) / values.length;
  const deviation = Math.sqrt(variance);
  return new Map(values.map((item) => [
    item.instrumentKey,
    roundCrossRuntime(deviation === 0 ? 0 : (item.value - mean) / deviation),
  ]));
}

function roundCrossRuntime(value: number): number {
  return Math.round(value * 1e8) / 1e8;
}

function quantile(ordered: number[], percentile: number): number {
  const position = (ordered.length - 1) * percentile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return ordered[lower];
  return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower);
}

function median(values: number[]): number {
  return quantile([...values].sort((left, right) => left - right), 0.5);
}

function isFiniteNumber(value: number | null): value is number {
  return value !== null && Number.isFinite(value);
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
  const values = selected.map((row) => (plan.factorPlan || plan.featurePlan.direction === 'higher')
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
