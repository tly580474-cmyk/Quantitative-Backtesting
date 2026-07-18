import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { Pool, RowDataPacket } from 'mysql2/promise';

export type CoverageStatus = 'pass' | 'warn' | 'fail';

export interface CoverageMatrixRow {
  key: string;
  label: string;
  status: CoverageStatus;
  rows: number;
  covered: number;
  total: number;
  coverage: number;
  minDate: string | null;
  maxDate: string | null;
  message: string;
  details?: Record<string, unknown>;
}

export interface CoverageMatrix {
  status: CoverageStatus;
  checkedAt: string;
  authoritativeDate: string | null;
  rows: CoverageMatrixRow[];
}

export async function readCoverageMatrixCache(
  pathInput: string,
  maxAgeMs: number,
): Promise<CoverageMatrix | null> {
  const path = resolve(pathInput);
  try {
    const [content, info] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
    if (Date.now() - info.mtimeMs > maxAgeMs) return null;
    const value = JSON.parse(content) as CoverageMatrix;
    return value && Array.isArray(value.rows) && typeof value.checkedAt === 'string' ? value : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return null;
  }
}

export async function writeCoverageMatrixCache(
  pathInput: string,
  matrix: CoverageMatrix,
): Promise<void> {
  const path = resolve(pathInput);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(matrix, null, 2)}\n`, 'utf8');
}

interface CoverageSqlRow extends RowDataPacket {
  rowsCount: number | string | null;
  covered: number | string | null;
  total: number | string | null;
  minDate: string | null;
  maxDate: string | null;
}

interface IndexCoverageSqlRow extends CoverageSqlRow {
  indices: number | string | null;
  validDates: number | string | null;
  weightedSnapshots: number | string | null;
}

export async function buildDataCoverageMatrix(
  pool: Pool,
  minuteRootInput: string,
): Promise<CoverageMatrix> {
  const [
    [dailyRows],
    [valuationRows],
    [adjustmentRows],
    [dividendRows],
    [industryRows],
    [indexRows],
    [dragonTigerRows],
  ] = await Promise.all([
    pool.query<CoverageSqlRow[]>(`
      SELECT COUNT(*) AS rowsCount,
             COUNT(DISTINCT CASE WHEN instrument.status='active' THEN bar.instrument_key END) AS covered,
             (SELECT COUNT(*) FROM instruments WHERE type='stock' AND status='active') AS total,
             DATE_FORMAT(MIN(bar.trade_date), '%Y-%m-%d') AS minDate,
             DATE_FORMAT(MAX(bar.trade_date), '%Y-%m-%d') AS maxDate
      FROM daily_bars_v2 AS bar
      INNER JOIN instruments AS instrument ON instrument.instrument_key=bar.instrument_key
      WHERE instrument.type='stock'
    `),
    pool.query<CoverageSqlRow[]>(`
      SELECT COUNT(*) AS rowsCount,
             COUNT(DISTINCT CASE WHEN instrument.status='active' THEN metric.instrument_key END) AS covered,
             (SELECT COUNT(*) FROM instruments WHERE type='stock' AND status='active') AS total,
             DATE_FORMAT(MIN(metric.trade_date), '%Y-%m-%d') AS minDate,
             DATE_FORMAT(MAX(metric.trade_date), '%Y-%m-%d') AS maxDate
      FROM daily_stock_metrics AS metric
      INNER JOIN instruments AS instrument ON instrument.instrument_key=metric.instrument_key
      WHERE instrument.type='stock'
    `),
    pool.query<CoverageSqlRow[]>(`
      SELECT COUNT(*) AS rowsCount,
             COUNT(DISTINCT CASE WHEN instrument.status='active' THEN publication.instrument_key END) AS covered,
             (SELECT COUNT(*) FROM instruments WHERE type='stock' AND status='active') AS total,
             DATE_FORMAT(MIN(factor.effective_date), '%Y-%m-%d') AS minDate,
             DATE_FORMAT(MAX(publication.last_checked_date), '%Y-%m-%d') AS maxDate
      FROM adjustment_factor_publications AS publication
      INNER JOIN instruments AS instrument ON instrument.instrument_key=publication.instrument_key
      LEFT JOIN adjustment_factors_v2 AS factor
        ON factor.instrument_key=publication.instrument_key
       AND factor.factor_version=publication.factor_version
      WHERE instrument.type='stock'
    `),
    pool.query<CoverageSqlRow[]>(`
      SELECT (SELECT COUNT(*) FROM dividend_events) AS rowsCount,
             SUM(item.status IN ('completed', 'no_data')) AS covered,
             (SELECT COUNT(*) FROM instruments WHERE type='stock') AS total,
             DATE_FORMAT((SELECT MIN(ex_date) FROM dividend_events), '%Y-%m-%d') AS minDate,
             DATE_FORMAT((SELECT MAX(ex_date) FROM dividend_events), '%Y-%m-%d') AS maxDate
      FROM reference_data_backfill_items AS item
      WHERE item.task_key='dividend-history-akshare-em'
    `),
    pool.query<CoverageSqlRow[]>(`
      SELECT COUNT(*) AS rowsCount,
             COUNT(DISTINCT CASE
               WHEN instrument.status='active' AND membership.effective_to IS NULL
               THEN membership.instrument_key
             END) AS covered,
             (SELECT COUNT(*) FROM instruments WHERE type='stock' AND status='active') AS total,
             DATE_FORMAT(MIN(membership.effective_from), '%Y-%m-%d') AS minDate,
             DATE_FORMAT(MAX(membership.effective_from), '%Y-%m-%d') AS maxDate
      FROM sw_industry_memberships AS membership
      INNER JOIN instruments AS instrument ON instrument.instrument_key=membership.instrument_key
      WHERE membership.taxonomy_key='SW2021'
    `),
    pool.query<IndexCoverageSqlRow[]>(`
      SELECT COUNT(*) AS rowsCount,
             COUNT(DISTINCT index_code) AS covered,
             6 AS total,
             DATE_FORMAT(MIN(constituent_date), '%Y-%m-%d') AS minDate,
             DATE_FORMAT(MAX(constituent_date), '%Y-%m-%d') AS maxDate,
             COUNT(DISTINCT index_code) AS indices,
             COUNT(DISTINCT CASE
               WHEN weight_date IS NOT NULL
                AND (
                  weight_method='official'
                  OR (
                    weight_method='price_drift_verified'
                    AND validation_half_l1_pct <= 1.5
                  )
                )
               THEN constituent_date
             END) AS validDates,
             SUM(
               weight_date IS NOT NULL
               AND (
                 weight_method='official'
                 OR (
                   weight_method='price_drift_verified'
                   AND validation_half_l1_pct <= 1.5
                 )
               )
             ) AS weightedSnapshots
      FROM index_constituent_snapshots
      WHERE status='published'
    `),
    pool.query<CoverageSqlRow[]>(`
      WITH covered_days AS (
        SELECT trade_date
        FROM dragon_tiger_billboards
        GROUP BY trade_date
        HAVING COUNT(*) >= 10
      )
      SELECT
        (SELECT COUNT(*) FROM dragon_tiger_billboards) AS rowsCount,
        (SELECT COUNT(*) FROM covered_days) AS covered,
        (
          SELECT COUNT(DISTINCT calendar.trade_date)
          FROM trading_calendar AS calendar
          WHERE calendar.is_open=1
            AND calendar.market IN ('CN', 'SH', 'SZ')
            AND calendar.trade_date BETWEEN
              DATE_FORMAT((SELECT MIN(trade_date) FROM covered_days), '%Y-%m-%d')
              AND DATE_FORMAT((SELECT MAX(trade_date) FROM covered_days), '%Y-%m-%d')
        ) AS total,
        DATE_FORMAT((SELECT MIN(trade_date) FROM covered_days), '%Y-%m-%d') AS minDate,
        DATE_FORMAT((SELECT MAX(trade_date) FROM covered_days), '%Y-%m-%d') AS maxDate
    `),
  ]);

  const authoritativeDate = dailyRows[0]?.maxDate ?? null;
  const rows = [
    coverageRow('daily_prices', '股票日线行情', dailyRows[0], 0.99),
    coverageRow('valuations', '日线估值与市值', valuationRows[0], 0.95),
    coverageRow('adjustments', '复权参数发布', adjustmentRows[0], 0.99),
    coverageRow('dividends', '分红历史状态', dividendRows[0], 1),
    coverageRow('sw_industry', '申万行业有效归属', industryRows[0], 0.99),
    indexCoverageRow(indexRows[0]),
    coverageRow('dragon_tiger', '龙虎榜交易日覆盖', dragonTigerRows[0], 0.95),
    await minuteCoverageRow(minuteRootInput, authoritativeDate),
  ];
  return {
    status: aggregateStatus(rows.map((row) => row.status)),
    checkedAt: new Date().toISOString(),
    authoritativeDate,
    rows,
  };
}

export function assessCoverage(
  covered: number,
  total: number,
  passThreshold: number,
): { status: CoverageStatus; coverage: number } {
  const coverage = total > 0 ? covered / total : 0;
  return {
    status: coverage >= passThreshold
      ? 'pass'
      : coverage >= Math.max(0, passThreshold - 0.05) ? 'warn' : 'fail',
    coverage,
  };
}

function coverageRow(
  key: string,
  label: string,
  row: CoverageSqlRow | undefined,
  threshold: number,
): CoverageMatrixRow {
  const covered = numberOf(row?.covered);
  const total = numberOf(row?.total);
  const assessment = assessCoverage(covered, total, threshold);
  return {
    key,
    label,
    status: assessment.status,
    rows: numberOf(row?.rowsCount),
    covered,
    total,
    coverage: assessment.coverage,
    minDate: row?.minDate ?? null,
    maxDate: row?.maxDate ?? null,
    message: `${covered}/${total}，覆盖率 ${(assessment.coverage * 100).toFixed(2)}%`,
  };
}

function indexCoverageRow(row: IndexCoverageSqlRow | undefined): CoverageMatrixRow {
  const indices = numberOf(row?.indices);
  const validDates = numberOf(row?.validDates);
  const weightedSnapshots = numberOf(row?.weightedSnapshots);
  const base = coverageRow('index_weights', '指数成分与权重', row, 1);
  const ready = base.status === 'pass' && validDates >= 12 && weightedSnapshots >= 12;
  return {
    ...base,
    status: ready ? 'pass' : validDates >= 8 ? 'warn' : 'fail',
    message: `${indices}/6 个指数，${validDates} 个有效权重日期，${weightedSnapshots} 个加权快照`,
    details: { indices, validDates, weightedSnapshots },
  };
}

async function minuteCoverageRow(
  minuteRootInput: string,
  authoritativeDate: string | null,
): Promise<CoverageMatrixRow> {
  const root = resolve(minuteRootInput);
  try {
    const value = JSON.parse(
      await readFile(join(root, 'manifest.json'), 'utf8'),
    ) as Record<string, unknown>;
    const years = Array.isArray(value.years)
      ? value.years as Record<string, unknown>[]
      : [];
    const firstDates = years.map((item) => text(item.firstDate)).filter(isText).sort();
    const lastDates = years.map((item) => text(item.lastDate)).filter(isText).sort();
    const fileCount = years.reduce((sum, item) => sum + numberOf(item.fileCount), 0);
    const maxDate = text(value.lastDate) ?? lastDates.at(-1) ?? null;
    const current = authoritativeDate !== null && maxDate !== null && maxDate >= authoritativeDate;
    return {
      key: 'minute_lake',
      label: '分钟行情湖',
      status: current ? 'pass' : 'fail',
      rows: 0,
      covered: fileCount,
      total: fileCount,
      coverage: fileCount > 0 ? 1 : 0,
      minDate: text(value.firstDate) ?? firstDates[0] ?? null,
      maxDate,
      message: current
        ? `分钟湖已覆盖权威日期 ${authoritativeDate}`
        : `分钟湖日期 ${maxDate ?? 'N/A'} 落后于 ${authoritativeDate ?? 'N/A'}`,
      details: {
        root,
        preparedAt: text(value.preparedAt),
        tradingDays: fileCount,
      },
    };
  } catch (error) {
    return {
      key: 'minute_lake',
      label: '分钟行情湖',
      status: 'fail',
      rows: 0,
      covered: 0,
      total: 0,
      coverage: 0,
      minDate: null,
      maxDate: null,
      message: error instanceof Error ? error.message : String(error),
      details: { root },
    };
  }
}

function aggregateStatus(statuses: CoverageStatus[]): CoverageStatus {
  return statuses.includes('fail') ? 'fail' : statuses.includes('warn') ? 'warn' : 'pass';
}

function numberOf(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function isText(value: string | null): value is string {
  return value !== null;
}
