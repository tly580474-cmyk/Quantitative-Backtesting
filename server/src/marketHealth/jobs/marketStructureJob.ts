import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openManagedDuckDB } from '../../research/duckdbRuntime.js';
import { readCurrentSnapshot } from '../../research/snapshotManifest.js';
import { calculateMarketStructure, type MarketStructureRawPoint } from '../calculation/marketStructure.js';
import { getLatestMarketHealthSnapshot, publishMarketHealthSnapshot } from '../repository.js';
import { invalidateMarketHealthCache } from '../service.js';

export interface MarketStructureRefreshResult {
  snapshotId: string;
  asOfDate: string;
  published: boolean;
}

export async function refreshMarketStructure(snapshotRootInput: string): Promise<MarketStructureRefreshResult> {
  const snapshotRoot = resolve(snapshotRootInput);
  const current = await readCurrentSnapshot(snapshotRoot);
  if (!current) throw new Error('研究快照不存在，无法物化 MSH');
  const datasetEntries = Object.fromEntries((current.manifest.datasets ?? []).map((item) => [item.name, item]));
  const adjustment = datasetEntries.adjustment_factors;
  const indexBars = datasetEntries.index_bars;
  const industryBars = datasetEntries.sw_industry_bars;
  if (!adjustment || !indexBars || !industryBars) throw new Error('研究快照缺少 MSH 必需数据集');
  const expectedAsOfDate = [current.manifest.maxDate, indexBars.maxDate, industryBars.maxDate]
    .filter((value): value is string => Boolean(value))
    .sort()[0];
  const existing = await getLatestMarketHealthSnapshot('msh');
  if (existing?.modelVersion === 'msh-v1'
    && existing.asOfDate === expectedAsOfDate
    && existing.sourcePeriods.adjustmentDatasetSha === adjustment.sha256) {
    return { snapshotId: current.manifest.snapshotId, asOfDate: expectedAsOfDate, published: false };
  }
  const rows = await queryMarketStructureRawPoints(snapshotRoot, current.manifest.snapshotId,
    Object.fromEntries(Object.entries(datasetEntries).map(([name, item]) => [name, item.relativePath])));
  const snapshot = calculateMarketStructure(rows, current.manifest.snapshotId);
  if (!snapshot) throw new Error('MSH 行情或行业覆盖未通过发布门禁');
  snapshot.sourcePeriods.barsMaxDate = current.manifest.maxDate;
  snapshot.sourcePeriods.indexBarsMaxDate = indexBars.maxDate;
  snapshot.sourcePeriods.industryBarsMaxDate = industryBars.maxDate;
  snapshot.sourcePeriods.adjustmentDatasetSha = adjustment.sha256;
  await publishMarketHealthSnapshot(snapshot);
  invalidateMarketHealthCache();
  return { snapshotId: current.manifest.snapshotId, asOfDate: snapshot.asOfDate, published: true };
}

export async function queryMarketStructureRawPoints(
  snapshotRoot: string,
  snapshotId: string,
  datasets: Record<string, string>,
): Promise<MarketStructureRawPoint[]> {
  const required = ['adjustment_factors', 'index_bars', 'sw_industry_bars'] as const;
  for (const name of required) {
    if (!datasets[name]) throw new Error(`研究快照缺少 ${name} 数据集`);
  }
  const replacements: Record<string, string> = {
    __BARS_PATH__: normalizePath(join(snapshotRoot, snapshotId, 'bars', 'year=*', '*.parquet')),
    __ADJUSTMENT_PATH__: normalizePath(join(snapshotRoot, snapshotId, datasets.adjustment_factors)),
    __INDEX_PATH__: normalizePath(join(snapshotRoot, snapshotId, datasets.index_bars)),
    __INDUSTRY_PATH__: normalizePath(join(snapshotRoot, snapshotId, datasets.sw_industry_bars)),
  };
  let sql = await readFile(fileURLToPath(new URL('../calculation/marketStructureRaw.sql', import.meta.url)), 'utf8');
  for (const [key, value] of Object.entries(replacements)) sql = sql.replaceAll(key, escapeSql(value));
  const session = await openManagedDuckDB({
    label: 'market-health-msh',
    config: { threads: '4', max_memory: '4GB' },
  });
  try {
    await session.connection.run(sql);
    const reader = await session.connection.runAndReadAll('SELECT * FROM market_structure_raw ORDER BY tradeDate');
    return reader.getRowObjectsJson().map(toRawPoint);
  } finally {
    await session.close();
  }
}

function toRawPoint(row: Record<string, unknown>): MarketStructureRawPoint {
  return {
    tradeDate: String(row.tradeDate).slice(0, 10),
    eligibleStocks: requiredNumber(row.eligible_stocks),
    availableIndices: requiredNumber(row.available_indices),
    availableIndustries: requiredNumber(row.available_industries),
    indexReturn20d: numberValue(row.index_return_20d),
    indexReturn60d: numberValue(row.index_return_60d),
    indexTrendAlignment: numberValue(row.index_trend_alignment),
    pctAboveMa20: numberValue(row.pct_above_ma20),
    pctAboveMa60: numberValue(row.pct_above_ma60),
    pctIndustriesAboveMa60: numberValue(row.pct_industries_above_ma60),
    downsideSemivol20d: numberValue(row.downside_semivol_20d),
    drawdownMagnitude60d: numberValue(row.drawdown_magnitude_60d),
    downsideComovement20d: numberValue(row.downside_comovement_20d),
    medianAmihud20d: numberValue(row.median_amihud_20d),
    liquidityDroughtFraction: numberValue(row.liquidity_drought_fraction),
    turnoverTop5PctShare: numberValue(row.turnover_top5pct_share),
  };
}

function requiredNumber(value: unknown): number {
  const result = numberValue(value);
  if (result == null) throw new Error('MSH 原始结果缺少覆盖数据');
  return result;
}

function numberValue(value: unknown): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizePath(value: string): string {
  return value.replaceAll('\\', '/');
}

function escapeSql(value: string): string {
  return value.replaceAll("'", "''");
}
