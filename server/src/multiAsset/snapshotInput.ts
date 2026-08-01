import { join, resolve } from 'node:path';
import { z } from 'zod';
import { canonicalHash } from '../experiments/schema.js';
import { openManagedDuckDB } from '../research/duckdbRuntime.js';
import { readCurrentSnapshot } from '../research/snapshotManifest.js';
import type { ExecutionBar } from './execution.js';
import type { MultiAssetPlan, PointInTimeFeatureRow, RebalancePlan } from './schema.js';

export const snapshotMultiAssetConfigSchema = z.strictObject({
  indexCode: z.string().regex(/^\d{6}$/),
  startDate: z.iso.date(),
  endDate: z.iso.date(),
  frequency: z.enum(['weekly', 'monthly']),
  topN: z.number().int().min(1).max(500),
  weighting: z.enum(['equal', 'score']),
  maxGrossExposure: z.number().finite().positive().max(1).default(0.95),
  maxSingleWeight: z.number().finite().positive().max(1).default(0.1),
  minCashWeight: z.number().finite().min(0).max(1).default(0.05),
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
               CASE WHEN lag(close, 20) OVER instrument_window > 0
                    THEN close / lag(close, 20) OVER instrument_window - 1
                    ELSE NULL END AS featureValue
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
        featureId: 'momentum_20', featureVersion: 'close-momentum-20-v1',
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
): Promise<ExecutionBar[]> {
  const snapshotRoot = resolve(snapshotRootInput);
  const current = await readCurrentSnapshot(snapshotRoot);
  if (!current || current.manifest.snapshotId !== plan.snapshotId) throw new Error('EXECUTION_SNAPSHOT_MISMATCH');
  const requests = plan.decisions.flatMap((decision) => {
    const allInstruments = new Set(plan.decisions.flatMap((item) => item.targets.map((target) => target.instrumentKey)));
    return [...allInstruments].map((instrumentKey) => ({ tradeDate: decision.executableFrom, instrumentKey }));
  });
  const unique = [...new Map(requests.map((item) => [`${item.tradeDate}:${item.instrumentKey}`, item])).values()];
  if (unique.length === 0) return [];
  if (unique.some((item) => !/^\d+$/.test(item.instrumentKey))) throw new Error('SNAPSHOT_INSTRUMENT_KEY_INVALID');
  const values = unique.map((item) => `(DATE '${item.tradeDate}', ${BigInt(item.instrumentKey).toString()})`).join(',');
  const minDate = unique.map((item) => item.tradeDate).sort()[0];
  const maxDate = unique.map((item) => item.tradeDate).sort().at(-1)!;
  const barsPath = normalizePath(join(snapshotRoot, current.manifest.snapshotId, 'bars', 'year=*', '*.parquet'));
  const session = await openManagedDuckDB({ label: 'multi-asset-execution-bars', config: { threads: '4' } });
  try {
    const reader = await session.connection.runAndReadAll(`
      WITH requests(tradeDate, instrumentKey) AS (VALUES ${values}), candidates AS (
        SELECT request.tradeDate AS requestedDate, request.instrumentKey,
               bar.tradeDate AS actualDate, bar.open, bar.close,
               row_number() OVER (
                 PARTITION BY request.tradeDate, request.instrumentKey ORDER BY bar.tradeDate DESC
               ) AS recency
        FROM requests request
        LEFT JOIN read_parquet('${escapeSql(barsPath)}', hive_partitioning=true) bar
          ON bar.instrumentKey = request.instrumentKey
         AND bar.tradeDate <= request.tradeDate
         AND bar.tradeDate >= CAST($minDate AS DATE) - INTERVAL 370 DAY
         AND bar.tradeDate <= CAST($maxDate AS DATE)
      )
      SELECT requestedDate, instrumentKey, actualDate,
             CASE WHEN actualDate = requestedDate THEN open ELSE close END AS markOpen,
             actualDate = requestedDate AS tradable
      FROM candidates WHERE recency = 1
      ORDER BY requestedDate, instrumentKey
    `, { minDate, maxDate });
    const bars = reader.getRowObjectsJson().map((row): ExecutionBar => {
      if (row.actualDate == null || row.markOpen == null) {
        throw new Error(`EXECUTION_MARK_MISSING:${row.requestedDate}:${row.instrumentKey}`);
      }
      return {
        tradeDate: String(row.requestedDate),
        instrumentKey: String(row.instrumentKey),
        open: Number(row.markOpen),
        tradable: Boolean(row.tradable),
      };
    });
    if (bars.length !== unique.length) throw new Error('EXECUTION_BAR_COVERAGE_MISMATCH');
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
