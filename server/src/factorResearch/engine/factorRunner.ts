import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { readCurrentSnapshot } from '../../research/snapshotManifest.js';
import { requireBuiltinFactor, validateFactorRunConfig } from '../definitions/validator.js';
import type {
  DailyFactorMetric,
  FactorResearchReport,
  FactorRunConfig,
  LayerMetric,
} from '../definitions/schema.js';
import { compileBuiltinFactorSql, factorDirectionMultiplier } from './factorCompiler.js';
import { summarizeFactorReport } from './evaluator.js';

export interface RunFactorResearchOptions {
  snapshotRoot: string;
  artifactRoot?: string;
  config: FactorRunConfig;
  writeReport?: boolean;
}

export async function runFactorResearch(
  options: RunFactorResearchOptions,
): Promise<FactorResearchReport & { artifactPath?: string }> {
  const config = validateFactorRunConfig(options.config);
  const factor = requireBuiltinFactor(config.factorId);
  const snapshotRoot = resolve(options.snapshotRoot);
  const current = await readCurrentSnapshot(snapshotRoot);
  if (!current) throw new Error('尚未发布可用的研究快照');
  if (config.endDate > current.manifest.maxDate) {
    throw new Error(`研究结束日期 ${config.endDate} 超出当前快照最大日期 ${current.manifest.maxDate}`);
  }

  const parquetGlob = normalizeDuckDbPath(
    join(snapshotRoot, current.manifest.snapshotId, 'bars', 'year=*', '*.parquet'),
  );
  const factorSql = compileBuiltinFactorSql(factor);
  const directionMultiplier = factorDirectionMultiplier(factor);
  const values = buildQueryValues(config, factor.warmupDays);
  const filterSql = buildFilterSql(config, values);
  const commonCte = buildCommonCte(parquetGlob, factorSql, directionMultiplier, filterSql);

  const instance = await DuckDBInstance.create(':memory:', {
    access_mode: 'READ_WRITE',
    threads: '4',
    max_memory: '1GB',
  });
  const connection = await instance.connect();
  try {
    const dailyReader = await connection.runAndReadAll(`
      ${commonCte}
      SELECT CAST(tradeDate AS VARCHAR) AS tradeDate,
             COUNT(*) AS sampleCount,
             CORR(adjustedFactorValue, futureReturn) AS ic,
             CORR(factorRank, returnRank) AS rankIc
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
    const daily = dailyReader.getRowObjectsJson().map(toDailyMetric);
    const layers = layerReader.getRowObjectsJson().map(toLayerMetric);
    const report: FactorResearchReport & { artifactPath?: string } = {
      factor,
      snapshotId: current.manifest.snapshotId,
      sourceVersion: current.manifest.sourceVersion,
      config,
      summary: summarizeFactorReport(daily, layers),
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

function buildCommonCte(
  parquetGlob: string,
  factorSql: string,
  directionMultiplier: number,
  filterSql: string,
): string {
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
             ${factorSql} AS factorValue,
             LEAD(open, 1) OVER instrument_window AS entryOpen,
             LEAD(close, $horizonDays) OVER instrument_window AS exitClose
      FROM source
      WINDOW
        instrument_window AS (PARTITION BY instrumentKey ORDER BY tradeDate),
        trailing_14 AS (PARTITION BY instrumentKey ORDER BY tradeDate ROWS BETWEEN 13 PRECEDING AND CURRENT ROW),
        trailing_20 AS (PARTITION BY instrumentKey ORDER BY tradeDate ROWS BETWEEN 19 PRECEDING AND CURRENT ROW)
    ),
    analysis_rows AS (
      SELECT tradeDate,
             instrumentKey,
             market,
             symbol,
             factorValue,
             factorValue * ${directionMultiplier} AS adjustedFactorValue,
             exitClose / NULLIF(entryOpen, 0) - 1 AS futureReturn
      FROM scored
      WHERE tradeDate BETWEEN $startDate AND $endDate
        AND factorValue IS NOT NULL
        AND entryOpen IS NOT NULL
        AND exitClose IS NOT NULL
        AND entryOpen > 0
        AND exitClose > 0
        AND ($minDailyAmount IS NULL OR amount >= $minDailyAmount)
    ),
    ranked AS (
      SELECT *,
             RANK() OVER (PARTITION BY tradeDate ORDER BY adjustedFactorValue) AS factorRank,
             RANK() OVER (PARTITION BY tradeDate ORDER BY futureReturn) AS returnRank
      FROM analysis_rows
    ),
    layered AS (
      SELECT *,
             NTILE($layers) OVER (PARTITION BY tradeDate ORDER BY adjustedFactorValue) AS layer
      FROM analysis_rows
    )
  `;
}

function buildQueryValues(config: FactorRunConfig, warmupDays: number): Record<string, string | number | null> {
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

function buildFilterSql(config: FactorRunConfig, values: Record<string, string | number | null>): string {
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

async function writeReport(
  artifactRootInput: string | undefined,
  report: FactorResearchReport,
): Promise<string> {
  const artifactRoot = resolve(artifactRootInput ?? './data/factor-research');
  const runId = `${report.factor.id}-${report.config.startDate}-${report.config.endDate}-${Date.now()}`;
  const outputDir = join(artifactRoot, 'reports', runId);
  await mkdir(outputDir, { recursive: true });
  const outputPath = join(outputDir, 'summary.json');
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return outputPath;
}

function nullableNumber(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
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
