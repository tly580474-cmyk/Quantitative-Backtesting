import { join, resolve } from 'node:path';
import { z } from 'zod';
import { canonicalHash } from '../experiments/schema.js';
import { BUILTIN_FACTORS } from '../factorResearch/definitions/builtins.js';
import { compileBuiltinFactorSql } from '../factorResearch/engine/factorCompiler.js';
import { openManagedDuckDB } from '../research/duckdbRuntime.js';
import { readCurrentSnapshot } from '../research/snapshotManifest.js';
import type { ExecutionBar } from './execution.js';
import type { MultiAssetPlan, PointInTimeFeatureRow, RebalancePlan } from './schema.js';

export const snapshotMultiAssetConfigSchema = z.strictObject({
  indexCode: z.enum(['000300', '000905']),
  startDate: z.iso.date(),
  endDate: z.iso.date(),
  frequency: z.enum(['weekly', 'monthly']),
  topN: z.number().int().min(1).max(500),
  weighting: z.enum(['equal', 'score']),
  maxGrossExposure: z.number().finite().positive().max(1).default(0.95),
  maxSingleWeight: z.number().finite().positive().max(1).default(0.1),
  minCashWeight: z.number().finite().min(0).max(1).default(0.05),
  factorVersionId: z.string().trim().min(1).max(96).optional(),
  strategyVersionId: z.string().uuid().optional(),
});

const snapshotRequestSchema = snapshotMultiAssetConfigSchema.extend({
  snapshotRoot: z.string().trim().min(1),
});

export type SnapshotMultiAssetConfig = z.infer<typeof snapshotMultiAssetConfigSchema>;

export interface SnapshotMultiAssetInput {
  sourcePlan: MultiAssetPlan;
  rows: PointInTimeFeatureRow[];
  provenance: {
    snapshotId: string;
    publishedAt: string;
    indexCode: string;
    startDate: string;
    endDate: string;
    feature: 'momentum_20';
    rowCount: number;
  };
}

/** Reads only a published research snapshot and builds point-in-time momentum rows. */
export async function loadSnapshotMomentumInput(rawRequest: unknown): Promise<SnapshotMultiAssetInput> {
  const request = snapshotRequestSchema.parse(rawRequest);
  if (request.startDate > request.endDate) throw new Error('SNAPSHOT_DATE_RANGE_INVALID');
  const snapshotRoot = resolve(request.snapshotRoot);
  const current = await readCurrentSnapshot(snapshotRoot);
  if (!current) throw new Error('RESEARCH_SNAPSHOT_UNAVAILABLE');
  const members = current.manifest.datasets?.find((dataset) => dataset.name === 'index_constituents');
  const versions = current.manifest.datasets?.find((dataset) => dataset.name === 'index_constituent_snapshots');
  if (!members || !versions) throw new Error('POINT_IN_TIME_INDEX_DATASET_UNAVAILABLE');

  const barsPath = normalizePath(join(snapshotRoot, current.manifest.snapshotId, 'bars', 'year=*', '*.parquet'));
  const membersPath = normalizePath(join(snapshotRoot, current.manifest.snapshotId, members.relativePath));
  const versionsPath = normalizePath(join(snapshotRoot, current.manifest.snapshotId, versions.relativePath));
  const momentumDefinition = BUILTIN_FACTORS.find((factor) => factor.id === 'momentum_20');
  if (!momentumDefinition) throw new Error('MOMENTUM_20_DEFINITION_MISSING');
  const momentumSql = compileBuiltinFactorSql(momentumDefinition);
  const session = await openManagedDuckDB({
    label: 'multi-asset-snapshot-input',
    config: { threads: '4', max_memory: '2GB' },
  });
  try {
    const reader = await session.connection.runAndReadAll(`
      WITH all_bars AS (
        SELECT * EXCLUDE(year)
        FROM read_parquet('${escapeSql(barsPath)}', hive_partitioning=true)
        WHERE tradeDate BETWEEN CAST($startDate AS DATE) - INTERVAL 90 DAY
                            AND CAST($endDate AS DATE) + INTERVAL 10 DAY
      ), calendar AS (
        SELECT tradeDate,
               lead(tradeDate) OVER (ORDER BY tradeDate) AS executableFrom
        FROM (SELECT DISTINCT tradeDate FROM all_bars)
      ), decision_dates AS (
        SELECT tradeDate AS decisionDate, executableFrom
        FROM calendar
        WHERE tradeDate BETWEEN CAST($startDate AS DATE) AND CAST($endDate AS DATE)
          AND executableFrom IS NOT NULL
      ), snapshot_versions AS (
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
        FROM all_bars
        WINDOW instrument_window AS (PARTITION BY instrumentKey ORDER BY tradeDate)
      )
      SELECT decision.decisionDate, decision.executableFrom,
             CAST(member.instrumentKey AS VARCHAR) AS instrumentKey,
             member.memberFrom, member.memberTo, score.featureValue
      FROM decision_dates decision
      INNER JOIN members member
        ON member.memberFrom <= decision.decisionDate
       AND (member.memberTo IS NULL OR member.memberTo >= decision.decisionDate)
      LEFT JOIN scored score
        ON score.instrumentKey = member.instrumentKey
       AND score.tradeDate = decision.decisionDate
      ORDER BY decision.decisionDate, member.instrumentKey
    `, { indexCode: request.indexCode, startDate: request.startDate, endDate: request.endDate });
    const rows = reader.getRowObjectsJson().map((row): PointInTimeFeatureRow => ({
      decisionDate: String(row.decisionDate),
      executableFrom: String(row.executableFrom),
      instrumentKey: String(row.instrumentKey),
      memberFrom: String(row.memberFrom),
      memberTo: row.memberTo == null ? null : String(row.memberTo),
      featureValue: row.featureValue == null ? null : Number(row.featureValue),
    }));
    if (rows.length === 0) throw new Error('SNAPSHOT_POINT_IN_TIME_ROWS_EMPTY');
    const universeChecksum = canonicalHash({ members: members.sha256, versions: versions.sha256 });
    const sourcePlan: MultiAssetPlan = {
      planVersion: '1.0',
      snapshotId: current.manifest.snapshotId,
      snapshotChecksum: canonicalHash(current.manifest),
      calendarId: 'CN_XSHG_XSHE_1D',
      universePlan: {
        type: 'point_in_time',
        datasetId: `index:${request.indexCode}`,
        datasetChecksum: universeChecksum,
      },
      featurePlan: {
        featureId: 'momentum_20', featureVersion: request.factorVersionId ?? 'close-momentum-20-v1',
        direction: 'higher', missing: 'exclude',
      },
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
        indexCode: request.indexCode,
        startDate: request.startDate,
        endDate: request.endDate,
        feature: 'momentum_20',
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

function resolveDailyLimitRate(symbol: string, name: string): number {
  if (/(^|\*)ST/i.test(name)) return 0.05;
  if (/^(300|301|688|689)/.test(symbol)) return 0.20;
  if (/^(8|4|92)/.test(symbol)) return 0.30;
  return 0.10;
}
