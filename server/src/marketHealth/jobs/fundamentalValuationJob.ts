import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openManagedDuckDB } from '../../research/duckdbRuntime.js';
import { readCurrentSnapshot } from '../../research/snapshotManifest.js';
import {
  calculateFundamentalAndValuation,
  type FundamentalValuationRawPoint,
} from '../calculation/fundamentalValuation.js';
import { getLatestMarketHealthSnapshot, publishMarketHealthSnapshot } from '../repository.js';
import { invalidateMarketHealthCache } from '../service.js';

export interface FundamentalValuationRefreshResult {
  snapshotId: string;
  asOfDate: string;
  fhiPublished: boolean;
  vpiPublished: boolean;
}

export async function refreshFundamentalValuation(
  snapshotRootInput: string,
): Promise<FundamentalValuationRefreshResult> {
  const snapshotRoot = resolve(snapshotRootInput);
  const current = await readCurrentSnapshot(snapshotRoot);
  if (!current) throw new Error('研究快照不存在，无法物化 FHI/VPI');
  const financial = current.manifest.datasets?.find((item) => item.name === 'financial_reports');
  if (!financial) throw new Error('研究快照缺少 financial_reports 数据集');

  const [existingFhi, existingVpi] = await Promise.all([
    getLatestMarketHealthSnapshot('fhi'),
    getLatestMarketHealthSnapshot('vpi'),
  ]);
  const fhiCurrent = existingFhi?.modelVersion === 'fhi-v1'
    && existingFhi.sourcePeriods.financialDatasetSha === financial.sha256;
  const vpiCurrent = existingVpi?.modelVersion === 'vpi-v1'
    && existingVpi.asOfDate === current.manifest.maxDate;
  if (fhiCurrent && vpiCurrent) {
    return { snapshotId: current.manifest.snapshotId, asOfDate: current.manifest.maxDate, fhiPublished: false, vpiPublished: false };
  }

  const rows = await queryFundamentalValuationRawPoints(
    snapshotRoot,
    current.manifest.snapshotId,
    financial.relativePath,
  );
  const calculated = calculateFundamentalAndValuation(rows, current.manifest.snapshotId);
  let fhiPublished = false;
  let vpiPublished = false;
  if (!fhiCurrent && calculated.fhi) {
    calculated.fhi.sourcePeriods.financialDatasetSha = financial.sha256;
    await publishMarketHealthSnapshot(calculated.fhi);
    fhiPublished = true;
  }
  if (!vpiCurrent && calculated.vpi) {
    calculated.vpi.sourcePeriods.barsMaxDate = current.manifest.maxDate;
    await publishMarketHealthSnapshot(calculated.vpi);
    vpiPublished = true;
  }
  if (fhiPublished || vpiPublished) invalidateMarketHealthCache();
  return {
    snapshotId: current.manifest.snapshotId,
    asOfDate: rows.at(-1)?.tradeDate ?? current.manifest.maxDate,
    fhiPublished,
    vpiPublished,
  };
}

export async function queryFundamentalValuationRawPoints(
  snapshotRoot: string,
  snapshotId: string,
  financialRelativePath: string,
  dateLimit = 900,
): Promise<FundamentalValuationRawPoint[]> {
  const barsPath = normalizePath(join(snapshotRoot, snapshotId, 'bars', 'year=*', '*.parquet'));
  const financialPath = normalizePath(join(snapshotRoot, snapshotId, financialRelativePath));
  const template = await readFile(
    fileURLToPath(new URL('../calculation/fundamentalValuationRaw.sql', import.meta.url)),
    'utf8',
  );
  const sql = template
    .replaceAll('__BARS_PATH__', escapeSql(barsPath))
    .replaceAll('__FINANCIAL_PATH__', escapeSql(financialPath))
    .replaceAll('__DATE_LIMIT__', String(Math.min(10_000, Math.max(900, Math.trunc(dateLimit)))));
  const session = await openManagedDuckDB({
    label: 'market-health-fhi-vpi',
    config: { threads: '4', max_memory: '4GB' },
  });
  try {
    await session.connection.run(sql);
    const reader = await session.connection.runAndReadAll(`
      SELECT * FROM market_health_daily_raw ORDER BY tradeDate
    `);
    return reader.getRowObjectsJson().map(toRawPoint);
  } finally {
    await session.close();
  }
}

function toRawPoint(row: Record<string, unknown>): FundamentalValuationRawPoint {
  return {
    tradeDate: dateValue(row.tradeDate),
    eligibleStocks: numberValue(row.eligible_stocks) ?? 0,
    roeCoveragePct: numberValue(row.roe_coverage_pct),
    growthCoveragePct: numberValue(row.growth_coverage_pct),
    peCoveragePct: numberValue(row.pe_coverage_pct),
    pbCoveragePct: numberValue(row.pb_coverage_pct),
    latestReportPeriod: nullableDate(row.latest_report_period),
    latestAnnouncementDate: nullableDate(row.latest_announcement_date),
    aggregateRoe: numberValue(row.aggregate_roe),
    positiveRoeBreadth: numberValue(row.positive_roe_breadth),
    improvingRoeBreadth: numberValue(row.improving_roe_breadth),
    aggregateProfitGrowth: numberValue(row.aggregate_profit_growth),
    improvingProfitBreadth: numberValue(row.improving_profit_breadth),
    improvingRevenueBreadth: numberValue(row.improving_revenue_breadth),
    aggregatePe: numberValue(row.aggregate_pe),
    aggregatePb: numberValue(row.aggregate_pb),
  };
}

function numberValue(value: unknown): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function dateValue(value: unknown): string {
  const parsed = nullableDate(value);
  if (!parsed) throw new Error('FHI/VPI 原始结果缺少交易日');
  return parsed;
}

function nullableDate(value: unknown): string | null {
  if (value == null) return null;
  return String(value).slice(0, 10);
}

function normalizePath(value: string): string {
  return value.replaceAll('\\', '/');
}

function escapeSql(value: string): string {
  return value.replaceAll("'", "''");
}
