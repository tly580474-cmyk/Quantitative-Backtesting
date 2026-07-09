import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { readCurrentSnapshot } from '../../research/snapshotManifest.js';
import type {
  CompositeFactorResearchReport,
  CompositeFactorRunConfig,
  CompositeFactorWeight,
  DailyFactorMetric,
  FactorCorrelationMetric,
  FactorDefinition,
  LayerMetric,
} from '../definitions/schema.js';
import {
  requireBuiltinFactor,
  validateCompositeFactorRunConfig,
} from '../definitions/validator.js';
import { compileBuiltinFactorSql, factorDirectionMultiplier } from './factorCompiler.js';
import { summarizeFactorReport } from './evaluator.js';

export interface RunCompositeFactorResearchOptions {
  snapshotRoot: string;
  artifactRoot?: string;
  config: CompositeFactorRunConfig;
  writeReport?: boolean;
}

export async function runCompositeFactorResearch(
  options: RunCompositeFactorResearchOptions,
): Promise<CompositeFactorResearchReport & { artifactPath?: string }> {
  const config = validateCompositeFactorRunConfig(options.config);
  const factors = config.factorIds.map(requireBuiltinFactor);
  const snapshotRoot = resolve(options.snapshotRoot);
  const current = await readCurrentSnapshot(snapshotRoot);
  if (!current) throw new Error('尚未发布可用的研究快照');
  if (config.endDate > current.manifest.maxDate) {
    throw new Error(`研究结束日期 ${config.endDate} 超出当前快照最大日期 ${current.manifest.maxDate}`);
  }

  const parquetGlob = normalizeDuckDbPath(
    join(snapshotRoot, current.manifest.snapshotId, 'bars', 'year=*', '*.parquet'),
  );
  const values = buildQueryValues(config, Math.max(...factors.map((factor) => factor.warmupDays)));
  const filterSql = buildFilterSql(config, values);
  const equalWeights = factors.map(() => 1 / factors.length);

  const instance = await DuckDBInstance.create(':memory:', {
    access_mode: 'READ_WRITE',
    threads: '4',
    max_memory: '1GB',
  });
  const connection = await instance.connect();
  try {
    const weightCte = buildCompositeCommonCte(parquetGlob, factors, filterSql, equalWeights);
    const weightReader = await connection.runAndReadAll(`
      ${weightCte}
      ${buildWeightSelect(factors)}
    `, { ...values, validationStartDate: config.validationStartDate ?? null });
    const weights = resolveCompositeWeights(
      config,
      factors,
      weightReader.getRowObjectsJson().map(toWeightTrainingMetric),
    );
    const commonCte = buildCompositeCommonCte(
      parquetGlob,
      factors,
      filterSql,
      weights.map((item) => item.weight),
    );
    const dailyReader = await connection.runAndReadAll(`
      ${commonCte}
      SELECT CAST(tradeDate AS VARCHAR) AS tradeDate,
             COUNT(*) AS sampleCount,
             CORR(compositeScore, futureReturn) AS ic,
             CORR(compositeRank, returnRank) AS rankIc
      FROM ranked
      GROUP BY tradeDate
      HAVING COUNT(*) >= 3
      ORDER BY tradeDate
    `, values);
    const layerReader = await connection.runAndReadAll(`
      ${commonCte}
      SELECT layer,
             COUNT(*) AS sampleCount,
             AVG(futureReturn) AS averageReturn
      FROM layered
      GROUP BY layer
      ORDER BY layer
    `, values);
    const segmentLayerReader = config.validationStartDate
      ? await connection.runAndReadAll(`
        ${commonCte}
        SELECT CASE WHEN tradeDate < $validationStartDate THEN 'train' ELSE 'validation' END AS segment,
               layer,
               COUNT(*) AS sampleCount,
               AVG(futureReturn) AS averageReturn
        FROM layered
        GROUP BY segment, layer
        ORDER BY segment, layer
      `, { ...values, validationStartDate: config.validationStartDate })
      : null;
    const correlationReader = await connection.runAndReadAll(`
      ${commonCte}
      ${buildCorrelationSelect(factors)}
    `, values);

    const daily = dailyReader.getRowObjectsJson().map(toDailyMetric);
    const layers = layerReader.getRowObjectsJson().map(toLayerMetric);
    const segmentLayers = segmentLayerReader?.getRowObjectsJson().map(toSegmentLayerMetric) ?? [];
    const correlations = correlationReader.getRowObjectsJson().map(toCorrelationMetric);
    const baseSummary = summarizeFactorReport(daily, layers);
    const sampleSplit = config.validationStartDate
      ? buildSampleSplit(config.validationStartDate, daily, segmentLayers)
      : undefined;
    const report: CompositeFactorResearchReport & { artifactPath?: string } = {
      factors,
      snapshotId: current.manifest.snapshotId,
      sourceVersion: current.manifest.sourceVersion,
      config,
      summary: {
        ...baseSummary,
        factorCount: factors.length,
        averageAbsCorrelation: averageAbsCorrelation(correlations),
      },
      weights,
      sampleSplit,
      correlations,
      daily,
      layers,
      createdAt: new Date().toISOString(),
    };
    if (options.writeReport) {
      report.artifactPath = await writeReport(options.artifactRoot, report);
    }
    return report;
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

function buildSampleSplit(
  validationStartDate: string,
  daily: DailyFactorMetric[],
  segmentLayers: Array<{ segment: 'train' | 'validation'; metric: LayerMetric }>,
): CompositeFactorResearchReport['sampleSplit'] {
  return {
    train: summarizeFactorReport(
      daily.filter((item) => item.tradeDate < validationStartDate),
      segmentLayers.filter((item) => item.segment === 'train').map((item) => item.metric),
    ),
    validation: summarizeFactorReport(
      daily.filter((item) => item.tradeDate >= validationStartDate),
      segmentLayers.filter((item) => item.segment === 'validation').map((item) => item.metric),
    ),
  };
}

function buildCompositeCommonCte(
  parquetGlob: string,
  factors: FactorDefinition[],
  filterSql: string,
  weights: number[],
): string {
  const factorColumns = factors.map((factor, index) => (
    `${compileBuiltinFactorSql(factor)} AS rawFactor${index}`
  ));
  const adjustedColumns = factors.map((factor, index) => (
    `rawFactor${index} * ${factorDirectionMultiplier(factor)} AS factor${index}`
  ));
  const notNull = factors.map((_factor, index) => `factor${index} IS NOT NULL`).join(' AND ');
  const rankColumns = factors.map((_factor, index) => (
    `PERCENT_RANK() OVER (PARTITION BY tradeDate ORDER BY factor${index}) AS factorRank${index}`
  ));
  const compositeScore = factors
    .map((_factor, index) => `factorRank${index} * ${formatSqlNumber(weights[index] ?? 0)}`)
    .join(' + ');
  return `
    WITH source AS (
      SELECT *
      FROM read_parquet('${escapeSqlLiteral(parquetGlob)}', hive_partitioning = true)
      WHERE tradeDate BETWEEN $sourceStartDate AND $sourceEndDate
      ${filterSql}
    ),
    scored AS (
      SELECT tradeDate,
             instrumentKey,
             market,
             symbol,
             amount,
             ${factorColumns.join(',\n             ')},
             LEAD(open, 1) OVER instrument_window AS entryOpen,
             LEAD(close, $horizonDays) OVER instrument_window AS exitClose
      FROM source
      WINDOW
        instrument_window AS (PARTITION BY instrumentKey ORDER BY tradeDate),
        trailing_5 AS (PARTITION BY instrumentKey ORDER BY tradeDate ROWS BETWEEN 4 PRECEDING AND CURRENT ROW),
        trailing_10 AS (PARTITION BY instrumentKey ORDER BY tradeDate ROWS BETWEEN 9 PRECEDING AND CURRENT ROW),
        trailing_12 AS (PARTITION BY instrumentKey ORDER BY tradeDate ROWS BETWEEN 11 PRECEDING AND CURRENT ROW),
        trailing_14 AS (PARTITION BY instrumentKey ORDER BY tradeDate ROWS BETWEEN 13 PRECEDING AND CURRENT ROW),
        trailing_20 AS (PARTITION BY instrumentKey ORDER BY tradeDate ROWS BETWEEN 19 PRECEDING AND CURRENT ROW),
        trailing_28 AS (PARTITION BY instrumentKey ORDER BY tradeDate ROWS BETWEEN 27 PRECEDING AND CURRENT ROW),
        trailing_60 AS (PARTITION BY instrumentKey ORDER BY tradeDate ROWS BETWEEN 59 PRECEDING AND CURRENT ROW)
    ),
    analysis_rows AS (
      SELECT tradeDate,
             instrumentKey,
             market,
             symbol,
             ${adjustedColumns.join(',\n             ')},
             exitClose / NULLIF(entryOpen, 0) - 1 AS futureReturn
      FROM scored
      WHERE tradeDate BETWEEN $startDate AND $endDate
        AND entryOpen IS NOT NULL
        AND exitClose IS NOT NULL
        AND entryOpen > 0
        AND exitClose > 0
        AND ($minDailyAmount IS NULL OR amount >= $minDailyAmount)
    ),
    complete_rows AS (
      SELECT *
      FROM analysis_rows
      WHERE ${notNull}
    ),
    factor_ranks AS (
      SELECT *,
             ${rankColumns.join(',\n             ')},
             RANK() OVER (PARTITION BY tradeDate ORDER BY futureReturn) AS returnRank
      FROM complete_rows
    ),
    composite_rows AS (
      SELECT *,
             ${compositeScore} AS compositeScore
      FROM factor_ranks
    ),
    ranked AS (
      SELECT *,
             RANK() OVER (PARTITION BY tradeDate ORDER BY compositeScore) AS compositeRank,
             RANK() OVER (PARTITION BY tradeDate ORDER BY futureReturn) AS returnRank
      FROM composite_rows
    ),
    layered AS (
      SELECT *,
             NTILE($layers) OVER (PARTITION BY tradeDate ORDER BY compositeScore) AS layer
      FROM composite_rows
    )
  `;
}

function buildWeightSelect(factors: FactorDefinition[]): string {
  return factors.map((_factor, index) => `
    SELECT '${escapeSqlLiteral(factors[index].id)}' AS factorId,
           CORR(factor${index}, futureReturn) AS trainingIc,
           CORR(factorRank${index}, returnRank) AS trainingRankIc
    FROM factor_ranks
    WHERE ($validationStartDate IS NULL OR tradeDate < $validationStartDate)
  `).join('\nUNION ALL\n');
}

function buildCorrelationSelect(factors: FactorDefinition[]): string {
  const selects: string[] = [];
  for (let left = 0; left < factors.length; left += 1) {
    for (let right = left; right < factors.length; right += 1) {
      selects.push(`
        SELECT '${escapeSqlLiteral(factors[left].id)}' AS factorA,
               '${escapeSqlLiteral(factors[right].id)}' AS factorB,
               CORR(factor${left}, factor${right}) AS correlation,
               COUNT(*) AS sampleCount
        FROM complete_rows
      `);
    }
  }
  return selects.join('\nUNION ALL\n');
}

function buildQueryValues(
  config: CompositeFactorRunConfig,
  warmupDays: number,
): Record<string, string | number | null> {
  return {
    startDate: config.startDate,
    endDate: config.endDate,
    sourceStartDate: dateOffset(config.startDate, -Math.max(warmupDays * 3, 90)),
    sourceEndDate: dateOffset(config.endDate, Math.max(config.horizonDays * 3, 30)),
    horizonDays: config.horizonDays,
    layers: config.layers,
    minDailyAmount: config.minDailyAmount ?? null,
  };
}

function buildFilterSql(
  config: CompositeFactorRunConfig,
  values: Record<string, string | number | null>,
): string {
  const conditions: string[] = [];
  if (config.markets?.length) {
    const placeholders = config.markets.map((market, index) => {
      values[`market${index}`] = market;
      return `$market${index}`;
    });
    conditions.push(`market IN (${placeholders.join(', ')})`);
  }
  if (config.symbols?.length) {
    const placeholders = config.symbols.map((symbol, index) => {
      values[`symbol${index}`] = symbol;
      return `$symbol${index}`;
    });
    conditions.push(`symbol IN (${placeholders.join(', ')})`);
  }
  return conditions.length ? `AND ${conditions.join(' AND ')}` : '';
}

function toDailyMetric(row: Record<string, unknown>): DailyFactorMetric {
  return {
    tradeDate: String(row.tradeDate),
    sampleCount: Number(row.sampleCount ?? 0),
    ic: nullableNumber(row.ic),
    rankIc: nullableNumber(row.rankIc),
  };
}

function toLayerMetric(row: Record<string, unknown>): LayerMetric {
  return {
    layer: Number(row.layer),
    sampleCount: Number(row.sampleCount ?? 0),
    averageReturn: nullableNumber(row.averageReturn),
  };
}

function toSegmentLayerMetric(row: Record<string, unknown>): {
  segment: 'train' | 'validation';
  metric: LayerMetric;
} {
  return {
    segment: row.segment === 'train' ? 'train' : 'validation',
    metric: toLayerMetric(row),
  };
}

function toCorrelationMetric(row: Record<string, unknown>): FactorCorrelationMetric {
  return {
    factorA: String(row.factorA),
    factorB: String(row.factorB),
    correlation: nullableNumber(row.correlation),
    sampleCount: Number(row.sampleCount ?? 0),
  };
}

function toWeightTrainingMetric(row: Record<string, unknown>): {
  factorId: string;
  trainingIc: number | null;
  trainingRankIc: number | null;
} {
  return {
    factorId: String(row.factorId),
    trainingIc: nullableNumber(row.trainingIc),
    trainingRankIc: nullableNumber(row.trainingRankIc),
  };
}

function resolveCompositeWeights(
  config: CompositeFactorRunConfig,
  factors: FactorDefinition[],
  metrics: Array<{ factorId: string; trainingIc: number | null; trainingRankIc: number | null }>,
): CompositeFactorWeight[] {
  const metricByFactor = new Map(metrics.map((item) => [item.factorId, item]));
  const rawWeights = factors.map((factor) => {
    if (config.weighting === 'equal') return 1;
    if (config.weighting === 'manual') return config.manualWeights?.[factor.id] ?? 0;
    const metric = metricByFactor.get(factor.id);
    return config.weighting === 'ic'
      ? metric?.trainingIc ?? 0
      : metric?.trainingRankIc ?? 0;
  });
  const normalized = normalizeWeights(rawWeights);
  const source = rawWeights.some((weight) => weight !== 0)
    ? config.weighting
    : 'fallback-equal';
  return factors.map((factor, index) => {
    const metric = metricByFactor.get(factor.id);
    return {
      factorId: factor.id,
      weight: normalized[index],
      source,
      trainingIc: metric?.trainingIc ?? null,
      trainingRankIc: metric?.trainingRankIc ?? null,
    };
  });
}

function normalizeWeights(weights: number[]): number[] {
  const finite = weights.map((weight) => (Number.isFinite(weight) ? weight : 0));
  const absSum = finite.reduce((sum, weight) => sum + Math.abs(weight), 0);
  if (absSum === 0) return finite.map(() => 1 / finite.length);
  return finite.map((weight) => weight / absSum);
}

async function writeReport(
  artifactRootInput: string | undefined,
  report: CompositeFactorResearchReport,
): Promise<string> {
  const artifactRoot = resolve(artifactRootInput ?? './data/factor-research');
  const runId = `composite-${report.config.factorIds.join('_')}-${report.config.startDate}-${report.config.endDate}-${Date.now()}`;
  const outputDir = join(artifactRoot, 'composite-reports', runId);
  await mkdir(outputDir, { recursive: true });
  const outputPath = join(outputDir, 'summary.json');
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return outputPath;
}

function averageAbsCorrelation(correlations: FactorCorrelationMetric[]): number | null {
  const offDiagonal = correlations
    .filter((item) => item.factorA !== item.factorB)
    .map((item) => item.correlation)
    .filter(isNumber)
    .map(Math.abs);
  return offDiagonal.length
    ? offDiagonal.reduce((sum, value) => sum + value, 0) / offDiagonal.length
    : null;
}

function nullableNumber(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function dateOffset(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function normalizeDuckDbPath(path: string): string {
  return path.replaceAll('\\', '/');
}

function escapeSqlLiteral(value: string): string {
  return value.replaceAll("'", "''");
}

function formatSqlNumber(value: number): string {
  return Number.isFinite(value) ? String(value) : '0';
}
