import { join, resolve } from 'node:path';
import { z } from 'zod';
import { canonicalHash } from '../experiments/schema.js';
import { BUILTIN_FACTORS } from '../factorResearch/definitions/builtins.js';
import { compileBuiltinFactorSql } from '../factorResearch/engine/factorCompiler.js';
import { openManagedDuckDB } from '../research/duckdbRuntime.js';
import { readCurrentSnapshot } from '../research/snapshotManifest.js';
import type { ExecutionBar } from './execution.js';
import { factorPlanSchema } from './schema.js';
import type { MultiAssetPlan, PointInTimeFeatureRow, RebalancePlan } from './schema.js';

const commonSnapshotConfigShape = {
  startDate: z.iso.date(),
  endDate: z.iso.date(),
  frequency: z.enum(['weekly', 'monthly']),
  topN: z.number().int().min(1).max(500),
  weighting: z.enum(['equal', 'score']),
  maxGrossExposure: z.number().finite().positive().max(1).default(0.95),
  maxSingleWeight: z.number().finite().positive().max(1).default(0.1),
  minCashWeight: z.number().finite().min(0).max(1).default(0.05),
  factorVersionId: z.string().trim().min(1).max(96).optional(),
  factorPlan: factorPlanSchema.optional(),
  strategyVersionId: z.string().uuid().optional(),
};

export const universeSpecSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('index'), indexCode: z.enum(['000300', '000905']) }),
  z.strictObject({
    type: z.literal('all_a'),
    markets: z.array(z.enum(['SH', 'SZ', 'BJ'])).min(1).max(3),
    minHistoryDays: z.number().int().min(20).max(500).default(120),
    minValidBars20: z.number().int().min(1).max(20).default(20),
    maxSuspendedDays20: z.number().int().min(0).max(19).default(5),
    minAverageAmount20: z.number().finite().nonnegative().max(100_000_000_000).default(0),
    excludeRiskNames: z.boolean().default(true),
  }),
]);

const canonicalSnapshotConfigSchema = z.strictObject({
  universeSpec: universeSpecSchema,
  ...commonSnapshotConfigShape,
});
const legacySnapshotConfigSchema = z.strictObject({
  indexCode: z.enum(['000300', '000905']),
  ...commonSnapshotConfigShape,
}).transform(({ indexCode, ...config }) => ({
  universeSpec: { type: 'index' as const, indexCode },
  ...config,
}));

/** Accepts v1 indexCode plans, but always emits the versioned universeSpec form. */
export const snapshotMultiAssetConfigSchema = z.union([
  canonicalSnapshotConfigSchema,
  legacySnapshotConfigSchema,
]);

const snapshotRequestEnvelopeSchema = z.object({ snapshotRoot: z.string().trim().min(1) }).loose();

export type SnapshotMultiAssetConfig = z.infer<typeof snapshotMultiAssetConfigSchema>;

export interface SnapshotMultiAssetInput {
  sourcePlan: MultiAssetPlan;
  rows: PointInTimeFeatureRow[];
  provenance: {
    snapshotId: string;
    publishedAt: string;
    universe: z.infer<typeof universeSpecSchema>;
    startDate: string;
    endDate: string;
    feature: 'momentum_20' | 'multi_factor';
    rowCount: number;
  };
}

/** Reads only a published research snapshot and builds point-in-time momentum rows. */
export async function loadSnapshotMomentumInput(rawRequest: unknown): Promise<SnapshotMultiAssetInput> {
  const envelope = snapshotRequestEnvelopeSchema.parse(rawRequest);
  const { snapshotRoot: snapshotRootInput, ...rawConfig } = envelope;
  const request = { snapshotRoot: snapshotRootInput, ...snapshotMultiAssetConfigSchema.parse(rawConfig) };
  if (request.startDate > request.endDate) throw new Error('SNAPSHOT_DATE_RANGE_INVALID');
  const snapshotRoot = resolve(request.snapshotRoot);
  const current = await readCurrentSnapshot(snapshotRoot);
  if (!current) throw new Error('RESEARCH_SNAPSHOT_UNAVAILABLE');
  const members = current.manifest.datasets?.find((dataset) => dataset.name === 'index_constituents');
  const versions = current.manifest.datasets?.find((dataset) => dataset.name === 'index_constituent_snapshots');
  if (request.universeSpec.type === 'index' && (!members || !versions)) {
    throw new Error('POINT_IN_TIME_INDEX_DATASET_UNAVAILABLE');
  }

  const barsPath = normalizePath(join(snapshotRoot, current.manifest.snapshotId, 'bars', 'year=*', '*.parquet'));
  const membersPath = members ? normalizePath(join(snapshotRoot, current.manifest.snapshotId, members.relativePath)) : '';
  const versionsPath = versions ? normalizePath(join(snapshotRoot, current.manifest.snapshotId, versions.relativePath)) : '';
  const momentumDefinition = BUILTIN_FACTORS.find((factor) => factor.id === 'momentum_20');
  if (!momentumDefinition) throw new Error('MOMENTUM_20_DEFINITION_MISSING');
  const momentumSql = compileBuiltinFactorSql(momentumDefinition);
  const configuredFactors = request.factorPlan
    ? [...request.factorPlan.factors].sort((left, right) => left.factorId.localeCompare(right.factorId))
    : [];
  const factorSql = configuredFactors.map((factor, index) => {
    const definition = BUILTIN_FACTORS.find((item) => item.id === factor.factorId);
    if (!definition || definition.expression.type !== 'builtin') {
      throw new Error(`MULTI_ASSET_FACTOR_NOT_PUBLISHED:${factor.factorId}`);
    }
    return `${compileBuiltinFactorSql(definition)} AS factor_${index}`;
  });
  const factorSelect = configuredFactors.map((_factor, index) => `score.factor_${index}`).join(', ');
  const session = await openManagedDuckDB({
    label: 'multi-asset-snapshot-input',
    config: { threads: '4', max_memory: '2GB' },
  });
  try {
    const decisionPeriod = request.frequency === 'weekly'
      ? "strftime(tradeDate, '%G-%V')" : "strftime(tradeDate, '%Y-%m')";
    const sharedPrefix = `
      WITH all_bars AS (
        SELECT * EXCLUDE(year)
        FROM read_parquet('${escapeSql(barsPath)}', hive_partitioning=true)
        WHERE tradeDate BETWEEN CAST($startDate AS DATE) - INTERVAL 750 DAY
                            AND CAST($endDate AS DATE) + INTERVAL 10 DAY
      ), calendar AS (
        SELECT tradeDate,
               lead(tradeDate) OVER (ORDER BY tradeDate) AS executableFrom
        FROM (SELECT DISTINCT tradeDate FROM all_bars)
      ), decision_candidates AS (
        SELECT tradeDate, executableFrom,
               row_number() OVER (PARTITION BY ${decisionPeriod} ORDER BY tradeDate DESC) AS periodRank
        FROM calendar
        WHERE tradeDate BETWEEN CAST($startDate AS DATE) AND CAST($endDate AS DATE) AND executableFrom IS NOT NULL
      ), decision_dates AS (
        SELECT tradeDate AS decisionDate, executableFrom FROM decision_candidates WHERE periodRank = 1
      )`;
    const indexSql = `${sharedPrefix}, snapshot_versions AS (
        SELECT * EXCLUDE(versionRank)
        FROM (
          SELECT snapshot.*,
                 row_number() OVER (
                   PARTITION BY indexCode, constituentDate
                   ORDER BY CASE weightMethod WHEN 'official' THEN 2
                                              WHEN 'price_drift_verified' THEN 1 ELSE 0 END DESC,
                            (weightDate IS NOT NULL) DESC,
                            sourceCapturedAt DESC NULLS LAST,
                            fetchedAt DESC,
                            snapshotId
                 ) AS versionRank
          FROM read_parquet('${escapeSql(versionsPath)}') snapshot
          WHERE indexCode = $indexCode AND status IN ('published', 'validated')
        ) WHERE versionRank = 1
      ), membership_periods AS (
        SELECT snapshotId, constituentDate AS memberFrom,
               CAST(lead(constituentDate) OVER (ORDER BY constituentDate, snapshotId)
                    - INTERVAL 1 DAY AS DATE) AS memberTo
        FROM snapshot_versions
      ), members AS (
        SELECT member.instrumentKey, period.memberFrom, period.memberTo
        FROM read_parquet('${escapeSql(membersPath)}') member
        INNER JOIN membership_periods period USING (snapshotId)
        WHERE member.indexCode = $indexCode AND member.instrumentKey IS NOT NULL
      ), scored AS (
        SELECT instrumentKey, tradeDate,
               ${momentumSql} AS featureValue
               ${factorSql.length ? `, ${factorSql.join(', ')}` : ''}
        FROM all_bars
        WINDOW instrument_window AS (PARTITION BY instrumentKey ORDER BY tradeDate)
      )
      SELECT decision.decisionDate, decision.executableFrom,
             CAST(member.instrumentKey AS VARCHAR) AS instrumentKey,
             member.memberFrom, member.memberTo, score.featureValue
             ${factorSelect ? `, ${factorSelect}` : ''},
             false AS excludedRiskName, false AS excludedHistory,
             false AS excludedDataIncomplete, false AS excludedSuspended,
             false AS excludedLiquidity
      FROM decision_dates decision
      INNER JOIN members member
        ON member.memberFrom <= decision.decisionDate
       AND (member.memberTo IS NULL OR member.memberTo >= decision.decisionDate)
      LEFT JOIN scored score
        ON score.instrumentKey = member.instrumentKey
       AND score.tradeDate = decision.decisionDate
      ORDER BY decision.decisionDate, member.instrumentKey`;
    const allASpec = request.universeSpec.type === 'all_a' ? request.universeSpec : null;
    const marketsSql = allASpec?.markets.map((market) => `'${market}'`).join(',') ?? "'SH','SZ'";
    const allASql = `${sharedPrefix}, instrument_lifecycle AS (
        SELECT instrumentKey, min(tradeDate) AS memberFrom
        FROM read_parquet('${escapeSql(barsPath)}', hive_partitioning=true)
        WHERE instrumentKey IS NOT NULL
        GROUP BY instrumentKey
      ), scored AS (
        SELECT bar.instrumentKey, bar.market, bar.symbol, bar.name, bar.tradeDate,
               lifecycle.memberFrom,
               count(close) OVER instrument_history AS historyDays,
               count(close) OVER recent_window AS validBars20,
               count(CASE WHEN coalesce(volume, 0) > 0 THEN 1 END) OVER recent_window AS tradedBars20,
               avg(coalesce(amount, 0)) OVER recent_window AS averageAmount20,
               ${momentumSql} AS featureValue
               ${factorSql.length ? `, ${factorSql.join(', ')}` : ''}
        FROM all_bars bar
        INNER JOIN instrument_lifecycle lifecycle USING (instrumentKey)
        WINDOW instrument_history AS (PARTITION BY bar.instrumentKey ORDER BY bar.tradeDate ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW),
               recent_window AS (PARTITION BY bar.instrumentKey ORDER BY bar.tradeDate ROWS BETWEEN 19 PRECEDING AND CURRENT ROW),
               instrument_window AS (PARTITION BY bar.instrumentKey ORDER BY bar.tradeDate)
      )
      SELECT decision.decisionDate, decision.executableFrom,
             CAST(score.instrumentKey AS VARCHAR) AS instrumentKey,
             score.memberFrom, NULL::DATE AS memberTo, score.featureValue
             ${factorSelect ? `, ${factorSelect}` : ''},
             ($excludeRiskNames AND regexp_matches(coalesce(score.name, ''), '(?i)(\\*?ST|退市|退)')) AS excludedRiskName,
             score.historyDays < $minHistoryDays AS excludedHistory,
             score.validBars20 < $minValidBars20 AS excludedDataIncomplete,
             score.tradedBars20 < (20 - $maxSuspendedDays20) AS excludedSuspended,
             score.averageAmount20 < $minAverageAmount20 AS excludedLiquidity
      FROM decision_dates decision
      INNER JOIN scored score ON score.tradeDate = decision.decisionDate
      WHERE score.market IN (${marketsSql}) AND score.instrumentKey IS NOT NULL
      ORDER BY decision.decisionDate, score.instrumentKey`;
    const query = request.universeSpec.type === 'index'
      ? session.connection.runAndReadAll(indexSql, {
        indexCode: request.universeSpec.indexCode,
        startDate: request.startDate,
        endDate: request.endDate,
      })
      : session.connection.runAndReadAll(allASql, {
        startDate: request.startDate,
        endDate: request.endDate,
        excludeRiskNames: allASpec!.excludeRiskNames,
        minHistoryDays: allASpec!.minHistoryDays,
        minValidBars20: allASpec!.minValidBars20,
        maxSuspendedDays20: allASpec!.maxSuspendedDays20,
        minAverageAmount20: allASpec!.minAverageAmount20,
      });
    const reader = await withDeadline(Promise.resolve(query), 90_000, 'ALL_A_CROSS_SECTION_TIMEOUT');
    const candidateRows = reader.getRowObjectsJson();
    if (candidateRows.length > 1_000_000) throw new Error('ALL_A_CROSS_SECTION_ROW_LIMIT_EXCEEDED');
    const isEligible = (row: Record<string, unknown>) => !row.excludedRiskName && !row.excludedHistory
      && !row.excludedDataIncomplete && !row.excludedSuspended && !row.excludedLiquidity;
    const rows = candidateRows.filter(isEligible).map((row): PointInTimeFeatureRow => ({
      decisionDate: String(row.decisionDate),
      executableFrom: String(row.executableFrom),
      instrumentKey: String(row.instrumentKey),
      memberFrom: String(row.memberFrom),
      memberTo: row.memberTo == null ? null : String(row.memberTo),
      featureValue: row.featureValue == null ? null : Number(row.featureValue),
      factorValues: request.factorPlan ? Object.fromEntries(configuredFactors.map((factor, index) => [
        factor.factorId,
        row[`factor_${index}`] == null ? null : Number(row[`factor_${index}`]),
      ])) : undefined,
    }));
    if (rows.length === 0) throw new Error('SNAPSHOT_POINT_IN_TIME_ROWS_EMPTY');
    const auditByDate = new Map<string, typeof candidateRows>();
    for (const row of candidateRows) {
      const date = String(row.decisionDate);
      const values = auditByDate.get(date) ?? [];
      values.push(row);
      auditByDate.set(date, values);
    }
    const filterAudit = [...auditByDate.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([decisionDate, values]) => {
      const eligibleKeys = values.filter(isEligible).map((row) => String(row.instrumentKey)).sort();
      const exclusions = values.filter((row) => !isEligible(row)).map((row) => ({
        instrumentKey: String(row.instrumentKey),
        reasonCodes: [
          row.excludedRiskName ? 'risk_name' as const : null,
          row.excludedHistory ? 'insufficient_history' as const : null,
          row.excludedDataIncomplete ? 'incomplete_bars' as const : null,
          row.excludedSuspended ? 'suspended' as const : null,
          row.excludedLiquidity ? 'insufficient_liquidity' as const : null,
        ].filter((reason): reason is NonNullable<typeof reason> => reason !== null),
      })).sort((left, right) => left.instrumentKey.localeCompare(right.instrumentKey));
      return {
        decisionDate,
        candidates: values.length,
        eligible: eligibleKeys.length,
        excludedRiskName: values.filter((row) => row.excludedRiskName).length,
        excludedHistory: values.filter((row) => row.excludedHistory).length,
        excludedDataIncomplete: values.filter((row) => row.excludedDataIncomplete).length,
        excludedSuspended: values.filter((row) => row.excludedSuspended).length,
        excludedLiquidity: values.filter((row) => row.excludedLiquidity).length,
        eligibleUniverseHash: canonicalHash({ decisionDate, members: eligibleKeys }),
        exclusions,
      };
    });
    const universeChecksum = request.universeSpec.type === 'index'
      ? canonicalHash({ members: members!.sha256, versions: versions!.sha256 })
      : canonicalHash({ snapshotChecksum: canonicalHash(current.manifest), universeSpec: request.universeSpec });
    const sourcePlan: MultiAssetPlan = {
      planVersion: request.factorPlan ? '1.1' : '1.0',
      snapshotId: current.manifest.snapshotId,
      snapshotChecksum: canonicalHash(current.manifest),
      calendarId: 'CN_XSHG_XSHE_1D',
      universePlan: {
        type: 'point_in_time',
        datasetId: request.universeSpec.type === 'index'
          ? `index:${request.universeSpec.indexCode}` : 'all_a:point_in_time',
        datasetChecksum: universeChecksum,
        filterAudit,
      },
      featurePlan: {
        featureId: request.factorPlan?.factors[0]?.factorId ?? 'momentum_20',
        featureVersion: request.factorPlan?.factors[0]?.factorVersion
          ?? request.factorVersionId ?? 'close-momentum-20-v1',
        direction: request.factorPlan?.factors[0]?.direction ?? 'higher',
        missing: 'exclude',
      },
      factorPlan: request.factorPlan,
      signalPlan: { type: 'cross_sectional_rank', topN: request.topN, weighting: request.weighting },
      rebalancePolicy: { frequency: request.frequency, signalAt: 'close', fillAt: 'next_open' },
      portfolioPlan: {
        maxGrossExposure: request.maxGrossExposure,
        maxSingleWeight: request.maxSingleWeight,
        minCashWeight: request.minCashWeight,
        lotSize: 100,
      },
      executionPlan: {
        commissionRate: 0.0003, minimumCommission: 5,
        sellTaxRate: 0.0005, slippageRate: 0.001,
      },
      governancePlan: request.factorVersionId || request.strategyVersionId ? {
        factorVersionId: request.factorVersionId,
        strategyVersionId: request.strategyVersionId,
        role: 'research',
      } : undefined,
    };
    return {
      sourcePlan,
      rows,
      provenance: {
        snapshotId: current.manifest.snapshotId,
        publishedAt: current.pointer.publishedAt,
        universe: request.universeSpec,
        startDate: request.startDate,
        endDate: request.endDate,
        feature: request.factorPlan ? 'multi_factor' : 'momentum_20',
        rowCount: rows.length,
      },
    };
  } finally {
    await session.close();
  }
}

/** Supplies an exact open, or a last-close mark with tradable=false when the stock did not trade. */
export async function loadSnapshotExecutionBars(
  snapshotRootInput: string,
  plan: RebalancePlan,
  endDateInput?: string,
): Promise<ExecutionBar[]> {
  const snapshotRoot = resolve(snapshotRootInput);
  const current = await readCurrentSnapshot(snapshotRoot);
  if (!current || current.manifest.snapshotId !== plan.snapshotId) throw new Error('EXECUTION_SNAPSHOT_MISMATCH');
  const instruments = [...new Set(plan.decisions.flatMap((item) => item.targets.map((target) => target.instrumentKey)))];
  if (instruments.length === 0) return [];
  if (instruments.some((item) => !/^\d+$/.test(item))) throw new Error('SNAPSHOT_INSTRUMENT_KEY_INVALID');
  const instrumentValues = instruments.map((item) => BigInt(item).toString()).join(',');
  const minDate = plan.decisions.map((item) => item.executableFrom).sort()[0];
  const maxDate = endDateInput ?? plan.decisions.map((item) => item.executableFrom).sort().at(-1)!;
  const barsPath = normalizePath(join(snapshotRoot, current.manifest.snapshotId, 'bars', 'year=*', '*.parquet'));
  const session = await openManagedDuckDB({ label: 'multi-asset-execution-bars', config: { threads: '4' } });
  try {
    const reader = await session.connection.runAndReadAll(`
      SELECT tradeDate, instrumentKey, market, symbol, name, open, close, previousClose, volume
      FROM read_parquet('${escapeSql(barsPath)}', hive_partitioning=true)
      WHERE instrumentKey IN (${instrumentValues})
        AND tradeDate >= CAST($minDate AS DATE) - INTERVAL 370 DAY
        AND tradeDate <= CAST($maxDate AS DATE)
      ORDER BY tradeDate, instrumentKey
    `, { minDate, maxDate });
    const history = reader.getRowObjectsJson();
    const adjustmentsDataset = current.manifest.datasets?.find((dataset) => dataset.name === 'adjustment_factors');
    const adjustments = adjustmentsDataset ? (await session.connection.runAndReadAll(`
      SELECT instrumentKey, effectiveDate, factor, priceOffset
      FROM read_parquet('${escapeSql(normalizePath(join(snapshotRoot, current.manifest.snapshotId, adjustmentsDataset.relativePath)))}')
      WHERE instrumentKey IN (${instrumentValues}) AND effectiveDate <= CAST($maxDate AS DATE)
      ORDER BY instrumentKey, effectiveDate
    `, { maxDate })).getRowObjectsJson() : [];
    const adjustmentsByInstrument = new Map<string, typeof adjustments>();
    for (const row of adjustments) {
      const key = String(row.instrumentKey);
      const values = adjustmentsByInstrument.get(key) ?? [];
      values.push(row);
      adjustmentsByInstrument.set(key, values);
    }
    const priorAdjustment = new Map<string, { factor: number; offset: number }>();
    const historyByInstrument = new Map<string, typeof history>();
    for (const row of history) {
      const key = String(row.instrumentKey);
      const rows = historyByInstrument.get(key) ?? [];
      rows.push(row);
      historyByInstrument.set(key, rows);
    }
    const bars = history.filter((row) => String(row.tradeDate) >= minDate).map((row): ExecutionBar => {
      if (row.open == null || row.close == null) throw new Error(`EXECUTION_MARK_MISSING:${row.tradeDate}:${row.instrumentKey}`);
      const previousClose = Number(row.previousClose ?? 0);
      const limitRate = resolveDailyLimitRate(String(row.symbol ?? ''), String(row.name ?? ''));
      const instrumentKey = String(row.instrumentKey);
      const adjustmentRows = adjustmentsByInstrument.get(instrumentKey) ?? [];
      let applicable = { factor: 1, offset: 0 };
      for (const adjustment of adjustmentRows) {
        if (String(adjustment.effectiveDate) > String(row.tradeDate)) break;
        applicable = { factor: Number(adjustment.factor), offset: Number(adjustment.priceOffset ?? 0) };
      }
      const prior = priorAdjustment.get(instrumentKey) ?? applicable;
      const changed = Math.abs(applicable.factor - prior.factor) > 1e-12
        || Math.abs(applicable.offset - prior.offset) > 1e-12;
      priorAdjustment.set(instrumentKey, applicable);
      return {
        tradeDate: String(row.tradeDate),
        instrumentKey,
        open: Number(row.open), close: Number(row.close), volume: Number(row.volume ?? 0),
        limitUp: previousClose > 0 ? previousClose * (1 + limitRate) : null,
        limitDown: previousClose > 0 ? previousClose * (1 - limitRate) : null,
        corporateActionRatio: changed && prior.factor > 0 ? applicable.factor / prior.factor : 1,
        cashDividendPerShare: changed && prior.factor > 0
          ? Math.max(0, (applicable.offset - prior.offset) / prior.factor) : 0,
        delisted: false,
        tradable: Number(row.volume ?? 0) > 0,
      };
    });
    const byKey = new Map(bars.map((bar) => [`${bar.tradeDate}:${bar.instrumentKey}`, bar]));
    for (const decision of plan.decisions) {
      for (const instrumentKey of instruments) {
        const key = `${decision.executableFrom}:${instrumentKey}`;
        if (byKey.has(key)) continue;
        const instrumentHistory = historyByInstrument.get(instrumentKey) ?? [];
        let previous: (typeof history)[number] | undefined;
        for (let index = instrumentHistory.length - 1; index >= 0; index -= 1) {
          if (String(instrumentHistory[index].tradeDate) < decision.executableFrom) {
            previous = instrumentHistory[index];
            break;
          }
        }
        if (!previous?.close) throw new Error(`EXECUTION_MARK_MISSING:${decision.executableFrom}:${instrumentKey}`);
        const synthetic: ExecutionBar = {
          tradeDate: decision.executableFrom, instrumentKey, open: Number(previous.close),
          close: Number(previous.close), volume: 0, tradable: false,
          limitUp: null, limitDown: null, corporateActionRatio: 1, delisted: false,
          cashDividendPerShare: 0,
        };
        bars.push(synthetic);
        byKey.set(key, synthetic);
      }
    }
    bars.sort((left, right) => left.tradeDate.localeCompare(right.tradeDate)
      || left.instrumentKey.localeCompare(right.instrumentKey));
    return bars;
  } finally {
    await session.close();
  }
}

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/');
}

function escapeSql(value: string): string {
  return value.replaceAll("'", "''");
}

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number, code: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(code)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function resolveDailyLimitRate(symbol: string, name: string): number {
  if (/(^|\*)ST/i.test(name)) return 0.05;
  if (/^(300|301|688|689)/.test(symbol)) return 0.20;
  if (/^(8|4|92)/.test(symbol)) return 0.30;
  return 0.10;
}
