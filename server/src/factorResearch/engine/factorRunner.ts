import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { readCurrentSnapshot } from '../../research/snapshotManifest.js';
import { requireBuiltinFactor, validateFactorRunConfig } from '../definitions/validator.js';
import type {
  DailyFactorMetric,
  FactorResearchReport,
  FactorRunConfig,
  FactorDefinition,
  LayerMetric,
} from '../definitions/schema.js';
import { compileFactorSql, factorDirectionMultiplier } from './factorCompiler.js';
import { summarizeFactorReport } from './evaluator.js';

export interface RunFactorResearchOptions {
  snapshotRoot: string;
  artifactRoot?: string;
  config: FactorRunConfig;
  writeReport?: boolean;
  factorDefinition?: FactorDefinition;
}

export async function auditFactorCorrelations(options: {
  snapshotRoot: string; candidate: FactorDefinition; references: FactorDefinition[];
  startDate: string; endDate: string; horizonDays?: number;
}): Promise<Array<{ factorId: string; correlation: number | null; marginalIc: number | null }>> {
  const current = await readCurrentSnapshot(resolve(options.snapshotRoot));
  if (!current) throw new Error('尚未发布可用的研究快照');
  const references = options.references.filter((item) => item.id !== options.candidate.id).slice(0, 100);
  if (!references.length) return [];
  const parquetGlob = normalizeDuckDbPath(join(resolve(options.snapshotRoot), current.manifest.snapshotId,
    'bars', 'year=*', '*.parquet'));
  const candidateSql = compileFactorSql(options.candidate);
  const candidateMultiplier = factorDirectionMultiplier(options.candidate);
  const horizonDays = options.horizonDays ?? 5;
  const referenceSql = references.map((factor, index) => `${compileFactorSql(factor)} AS ref_${index}`);
  const warmup = Math.max(options.candidate.warmupDays, ...references.map((item) => item.warmupDays));
  const instance = await DuckDBInstance.create(':memory:', { threads: '4', max_memory: '1GB' });
  const connection = await instance.connect();
  try {
    const reader = await connection.runAndReadAll(`
      WITH source AS (
        SELECT * FROM read_parquet('${escapeSqlLiteral(parquetGlob)}', hive_partitioning = true)
        WHERE tradeDate BETWEEN $sourceStartDate AND $sourceEndDate
      ), scored AS (
        SELECT tradeDate, instrumentKey, (${candidateSql}) * ${candidateMultiplier} AS candidate_value,
               LEAD(open, 1) OVER instrument_window AS entryOpen,
               LEAD(close, ${horizonDays}) OVER instrument_window AS exitClose,
               ${referenceSql.join(', ')}
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
      ), ranked AS (
        SELECT tradeDate, entryOpen, exitClose,
               PERCENT_RANK() OVER (PARTITION BY tradeDate ORDER BY candidate_value) AS candidate_value,
               ${references.map((_, index) =>
                 `PERCENT_RANK() OVER (PARTITION BY tradeDate ORDER BY ref_${index}) AS ref_${index}`).join(', ')}
        FROM scored
      ), analysis AS (
        SELECT *, exitClose / NULLIF(entryOpen, 0) - 1 AS futureReturn FROM ranked
        WHERE tradeDate BETWEEN $startDate AND $endDate AND entryOpen > 0 AND exitClose > 0
      ), betas AS (
        SELECT ${references.map((_, index) =>
          `COVAR_POP(candidate_value, ref_${index}) / NULLIF(VAR_POP(ref_${index}), 0) AS beta_${index}`).join(', ')}
        FROM analysis
      )
      SELECT ${references.flatMap((_, index) => [
        `CORR(candidate_value, ref_${index}) AS corr_${index}`,
        `CORR(candidate_value - beta_${index} * ref_${index}, futureReturn) AS marginal_${index}`,
      ]).join(', ')}
      FROM analysis CROSS JOIN betas
    `, { startDate: options.startDate, endDate: options.endDate,
      sourceStartDate: dateOffset(options.startDate, -Math.max(warmup * 3, 90)),
      sourceEndDate: dateOffset(options.endDate, Math.max(horizonDays * 3, 30)) });
    const row = reader.getRowObjectsJson()[0] ?? {};
    return references.map((factor, index) => ({ factorId: factor.id,
      correlation: boundedCorrelation(row[`corr_${index}`]),
      marginalIc: nullableNumber(row[`marginal_${index}`]) }));
  } finally { connection.closeSync(); instance.closeSync(); }
}

export async function auditFactorDecay(options: {
  snapshotRoot: string; factor: FactorDefinition; startDate: string; endDate: string;
  horizons?: number[];
}): Promise<Array<{ horizonDays: number; ic: number | null }>> {
  const current = await readCurrentSnapshot(resolve(options.snapshotRoot));
  if (!current) throw new Error('尚未发布可用的研究快照');
  const horizons = [...new Set(options.horizons ?? [1, 5, 10, 20])]
    .filter((value) => Number.isInteger(value) && value >= 1 && value <= 60);
  const parquetGlob = normalizeDuckDbPath(join(resolve(options.snapshotRoot), current.manifest.snapshotId,
    'bars', 'year=*', '*.parquet'));
  const factorSql = compileFactorSql(options.factor);
  const instance = await DuckDBInstance.create(':memory:', { threads: '4', max_memory: '1GB' });
  const connection = await instance.connect();
  try {
    const reader = await connection.runAndReadAll(`
      WITH source AS (
        SELECT * FROM read_parquet('${escapeSqlLiteral(parquetGlob)}', hive_partitioning = true)
        WHERE tradeDate BETWEEN $sourceStartDate AND $sourceEndDate
      ), scored AS (
        SELECT tradeDate, instrumentKey, ${factorSql} AS factorValue,
               LEAD(open, 1) OVER instrument_window AS entryOpen,
               ${horizons.map((horizon) => `LEAD(close, ${horizon}) OVER instrument_window AS exit_${horizon}`).join(', ')}
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
      )
      SELECT ${horizons.map((horizon) =>
        `CORR(factorValue, exit_${horizon} / NULLIF(entryOpen, 0) - 1) AS ic_${horizon}`).join(', ')}
      FROM scored WHERE tradeDate BETWEEN $startDate AND $endDate
    `, { startDate: options.startDate, endDate: options.endDate,
      sourceStartDate: dateOffset(options.startDate, -Math.max(options.factor.warmupDays * 3, 90)),
      sourceEndDate: dateOffset(options.endDate, Math.max(...horizons) * 3) });
    const row = reader.getRowObjectsJson()[0] ?? {};
    return horizons.map((horizon) => ({ horizonDays: horizon, ic: nullableNumber(row[`ic_${horizon}`]) }));
  } finally { connection.closeSync(); instance.closeSync(); }
}

export async function runFactorResearch(
  options: RunFactorResearchOptions,
): Promise<FactorResearchReport & { artifactPath?: string }> {
  const config = validateFactorRunConfig(options.config, options.factorDefinition?.id);
  const factor = options.factorDefinition ?? requireBuiltinFactor(config.factorId);
  if (factor.id !== config.factorId) throw new Error('研究配置 factorId 与因子定义不一致');
  const snapshotRoot = resolve(options.snapshotRoot);
  const current = await readCurrentSnapshot(snapshotRoot);
  if (!current) throw new Error('尚未发布可用的研究快照');
  if (config.endDate > current.manifest.maxDate) {
    throw new Error(`研究结束日期 ${config.endDate} 超出当前快照最大日期 ${current.manifest.maxDate}`);
  }

  const parquetGlob = normalizeDuckDbPath(
    join(snapshotRoot, current.manifest.snapshotId, 'bars', 'year=*', '*.parquet'),
  );
  const factorSql = compileFactorSql(factor);
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
    const dailyLayerReader = await connection.runAndReadAll(`
      ${commonCte}
      SELECT CAST(tradeDate AS VARCHAR) AS tradeDate, layer, AVG(futureReturn) AS averageReturn
      FROM layered GROUP BY tradeDate, layer ORDER BY tradeDate, layer
    `, values);
    const robustnessReader = await connection.runAndReadAll(`
      ${commonCte}
      SELECT COUNT(*) AS validRows,
             CORR(adjustedFactorValue, LN(NULLIF(totalMarketCap, 0))) AS sizeExposure,
             CORR(adjustedFactorValue, LN(NULLIF(amount, 0))) AS liquidityExposure
      FROM analysis_rows
    `, values);
    const coverageReader = await connection.runAndReadAll(`
      ${commonCte}
      SELECT COUNT(*) AS totalRows, COUNT(factorValue) AS factorRows
      FROM scored WHERE tradeDate BETWEEN $startDate AND $endDate
    `, values);
    const capacityReader = await connection.runAndReadAll(`
      ${commonCte},
      transitions AS (
        SELECT tradeDate, instrumentKey, layer, amount,
               LAG(layer) OVER (PARTITION BY instrumentKey ORDER BY tradeDate) AS previousLayer
        FROM layered
      ), daily_capacity AS (
        SELECT tradeDate,
               SUM(CASE WHEN layer = $layers THEN amount ELSE 0 END) * 0.10 AS capacity,
               SUM(CASE WHEN layer = $layers AND previousLayer <> $layers THEN 1 ELSE 0 END)
                 / NULLIF(SUM(CASE WHEN layer = $layers THEN 1 ELSE 0 END), 0) AS turnover
        FROM transitions GROUP BY tradeDate
      )
      SELECT AVG(capacity) AS capacityEstimate, AVG(turnover) AS averageTurnover
      FROM daily_capacity
    `, values);
    const groupStabilityReader = await connection.runAndReadAll(`
      ${commonCte},
      size_rows AS (
        SELECT *, NTILE(3) OVER (PARTITION BY tradeDate ORDER BY totalMarketCap) AS sizeBucket
        FROM analysis_rows WHERE totalMarketCap IS NOT NULL AND totalMarketCap > 0
      ), daily_regime AS (
        SELECT tradeDate, CASE WHEN AVG(futureReturn) >= 0 THEN 'bull' ELSE 'bear' END AS regime
        FROM analysis_rows GROUP BY tradeDate
      ), grouped AS (
        SELECT 'market' AS dimension, market AS bucket, COUNT(*) AS sampleCount,
               CORR(adjustedFactorValue, futureReturn) AS ic FROM analysis_rows GROUP BY market
        UNION ALL
        SELECT 'industry', industry, COUNT(*), CORR(adjustedFactorValue, futureReturn)
        FROM analysis_rows WHERE industry IS NOT NULL GROUP BY industry HAVING COUNT(*) >= 100
        UNION ALL
        SELECT 'size', CAST(sizeBucket AS VARCHAR), COUNT(*), CORR(adjustedFactorValue, futureReturn)
        FROM size_rows GROUP BY sizeBucket
        UNION ALL
        SELECT 'regime', daily_regime.regime, COUNT(*), CORR(a.adjustedFactorValue, a.futureReturn)
        FROM analysis_rows a INNER JOIN daily_regime USING (tradeDate) GROUP BY daily_regime.regime
      )
      SELECT * FROM grouped ORDER BY dimension, bucket
    `, values);
    const daily = dailyReader.getRowObjectsJson().map(toDailyMetric);
    const layers = layerReader.getRowObjectsJson().map(toLayerMetric);
    const dailyLayers = dailyLayerReader.getRowObjectsJson().map((row) => ({
      tradeDate: String(row.tradeDate), layer: Number(row.layer), averageReturn: nullableNumber(row.averageReturn),
    }));
    const robustnessRow = robustnessReader.getRowObjectsJson()[0] ?? {};
    const coverageRow = coverageReader.getRowObjectsJson()[0] ?? {};
    const capacityRow = capacityReader.getRowObjectsJson()[0] ?? {};
    const groupStability = groupStabilityReader.getRowObjectsJson().map((row) => ({
      dimension: String(row.dimension) as 'market' | 'industry' | 'size' | 'regime',
      bucket: String(row.bucket), sampleCount: Number(row.sampleCount ?? 0), ic: nullableNumber(row.ic),
    }));
    const report: FactorResearchReport & { artifactPath?: string } = {
      factor,
      snapshotId: current.manifest.snapshotId,
      sourceVersion: current.manifest.sourceVersion,
      config,
      summary: summarizeFactorReport(daily, layers),
      daily,
      layers,
      portfolio: evaluateTradablePortfolio(dailyLayers, config.horizonDays, config.layers),
      robustness: {
        coverageRate: ratio(coverageRow.factorRows, coverageRow.totalRows),
        sizeExposure: nullableNumber(robustnessRow.sizeExposure),
        liquidityExposure: nullableNumber(robustnessRow.liquidityExposure),
        averageTopLayerTurnover: nullableNumber(capacityRow.averageTurnover),
        capacityEstimate: nullableNumber(capacityRow.capacityEstimate),
        regimeRankIc: summarizeRegimes(daily),
        groupStability,
      },
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
    WITH raw_source AS (
      SELECT *
      FROM read_parquet('${escapeSqlLiteral(parquetGlob)}', hive_partitioning = true)
      WHERE tradeDate BETWEEN $sourceStartDate AND $sourceEndDate
      ${filterSql}
    ),
    source AS (
      SELECT *, DENSE_RANK() OVER (ORDER BY tradeDate) AS tradingDayIndex
      FROM raw_source
    ),
    scored AS (
      SELECT tradeDate,
             instrumentKey,
             market,
             symbol,
             amount,
             industry,
             totalMarketCap,
             close AS signalClose,
             tradingDayIndex AS signalDayIndex,
             ${factorSql} AS factorValue,
             LEAD(open, 1) OVER instrument_window AS entryOpen,
             LEAD(volume, 1) OVER instrument_window AS entryVolume,
             LEAD(tradingDayIndex, 1) OVER instrument_window AS entryDayIndex,
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
             industry,
             totalMarketCap,
             amount,
             signalClose,
             signalDayIndex,
             entryVolume,
             entryDayIndex,
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
        AND entryVolume > 0
        AND entryDayIndex = signalDayIndex + 1
        AND ABS(entryOpen / NULLIF(signalClose, 0) - 1) < 0.095
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
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function boundedCorrelation(value: unknown): number | null {
  const numeric = nullableNumber(value);
  return numeric === null ? null : Math.max(-1, Math.min(1, numeric));
}

function ratio(numerator: unknown, denominator: unknown): number | null {
  const n = Number(numerator); const d = Number(denominator);
  return Number.isFinite(n) && Number.isFinite(d) && d > 0 ? n / d : null;
}

function evaluateTradablePortfolio(
  rows: Array<{ tradeDate: string; layer: number; averageReturn: number | null }>,
  horizonDays: number,
  layers: number,
): FactorResearchReport['portfolio'] {
  const byDate = new Map<string, Map<number, number>>();
  for (const row of rows) {
    if (row.averageReturn === null) continue;
    if (!byDate.has(row.tradeDate)) byDate.set(row.tradeDate, new Map());
    byDate.get(row.tradeDate)!.set(row.layer, row.averageReturn);
  }
  const gross = [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([, values]) => values.has(1) && values.has(layers) ? values.get(layers)! - values.get(1)! : null)
    .filter((value): value is number => value !== null)
    .filter((_, index) => index % horizonDays === 0);
  const costBpsPerLeg = 3 + 5 + 5 / 2;
  const net = gross.map((value) => value - 4 * costBpsPerLeg / 10_000);
  const stressed = gross.map((value) => value - 8 * costBpsPerLeg / 10_000);
  return {
    method: 'non-overlapping', holdingDays: horizonDays, observationCount: gross.length,
    grossSharpe: annualizedSharpe(gross, 252 / horizonDays),
    netSharpe: annualizedSharpe(net, 252 / horizonDays),
    stressedCostSharpe: annualizedSharpe(stressed, 252 / horizonDays),
    maxDrawdown: maxDrawdown(net), costBpsPerLeg,
  };
}

function annualizedSharpe(values: number[], periodsPerYear: number): number | null {
  if (values.length < 2) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  return variance > 0 ? mean / Math.sqrt(variance) * Math.sqrt(periodsPerYear) : null;
}

function maxDrawdown(values: number[]): number | null {
  if (!values.length) return null;
  let equity = 1; let peak = 1; let drawdown = 0;
  for (const value of values) { equity *= 1 + value; peak = Math.max(peak, equity); drawdown = Math.min(drawdown, equity / peak - 1); }
  return drawdown;
}

function summarizeRegimes(daily: DailyFactorMetric[]): FactorResearchReport['robustness']['regimeRankIc'] {
  if (!daily.length) return [];
  const size = Math.ceil(daily.length / 3);
  const regimes = [];
  for (let start = 0; start < daily.length; start += size) {
    const segment = daily.slice(start, start + size);
    const values = segment.map((item) => item.rankIc).filter((value): value is number => value !== null);
    regimes.push({ startDate: segment[0].tradeDate, endDate: segment.at(-1)!.tradeDate,
      averageRankIc: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null });
  }
  return regimes;
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
