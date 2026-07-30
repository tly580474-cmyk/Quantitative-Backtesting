import { join, resolve } from 'node:path';
import { openManagedDuckDB } from '../research/duckdbRuntime.js';
import { readCurrentSnapshot } from '../research/snapshotManifest.js';

const FACTORS = [
  { key: 'roe', direction: 1, capNeutral: true },
  { key: 'grossMargin', direction: 1, capNeutral: true },
  { key: 'ocfToRevenue', direction: 1, capNeutral: true },
  { key: 'fcfToEv', direction: 1, capNeutral: true },
  { key: 'debtToAssets', direction: -1, capNeutral: true },
  { key: 'receivablesTurnover', direction: 1, capNeutral: true },
  { key: 'inventoryTurnover', direction: 1, capNeutral: true },
  { key: 'logMarketCap', direction: 1, capNeutral: false },
  { key: 'logRevenue', direction: 1, capNeutral: false },
  { key: 'logAssets', direction: 1, capNeutral: false },
  { key: 'turnover', direction: -1, capNeutral: true },
  { key: 'turnover20', direction: -1, capNeutral: true },
  { key: 'turnoverStd20', direction: -1, capNeutral: true },
] as const;

const FACTOR_COUNT = FACTORS.length;
const MIN_FACTOR_COUNT = 10;
const DEFAULT_SELECTION_SIZE = 100;
const HISTORY_SESSIONS = 6;

type FactorKey = typeof FACTORS[number]['key'];

export interface RawSelectionRow {
  instrumentKey: string;
  market: string;
  symbol: string;
  name: string;
  industry: string;
  tradeDate: string;
  close: number;
  latestPrice: number;
  financialAsOf: string | null;
  values: Record<FactorKey, number | null>;
}

export interface FactorSelectionItem {
  rank: number;
  code: string;
  name: string;
  market: 'SH' | 'SZ';
  industry: string;
  selectionScore: number;
  factorCount: number;
  selectedPrice: number;
  latestPrice: number;
  returnSinceSelectionPct: number;
  financialAsOf: string | null;
}

export interface FactorSelectionBatch {
  tradeDate: string;
  isLatest: boolean;
  averageReturnPct: number;
  positiveCount: number;
  items: FactorSelectionItem[];
}

export interface FactorSelectionHistory {
  strategy: '13因子-中性化';
  snapshotId: string;
  snapshotCreatedAt: string;
  dataAsOf: string;
  generatedAt: string;
  methodology: {
    factorCount: number;
    minimumFactorCount: number;
    selectionSize: number;
    retainedSessions: number;
    processing: string[];
  };
  batches: FactorSelectionBatch[];
}

const resultCache = new Map<string, Promise<FactorSelectionHistory>>();

export async function getFactorSelectionHistory(
  snapshotRoot: string,
  options: { force?: boolean; selectionSize?: number } = {},
): Promise<FactorSelectionHistory> {
  const root = resolve(snapshotRoot);
  const current = await readCurrentSnapshot(root);
  if (!current) throw new Error('尚未发布可用的研究快照');
  const selectionSize = Math.max(10, Math.min(200, Math.trunc(
    options.selectionSize ?? DEFAULT_SELECTION_SIZE,
  )));
  const cacheKey = `${current.manifest.snapshotId}:${selectionSize}`;
  if (options.force) resultCache.delete(cacheKey);
  const cached = resultCache.get(cacheKey);
  if (cached) return cached;
  const task = buildFactorSelectionHistory(root, current, selectionSize)
    .catch((error) => {
      resultCache.delete(cacheKey);
      throw error;
    });
  resultCache.set(cacheKey, task);
  return task;
}

async function buildFactorSelectionHistory(
  root: string,
  current: NonNullable<Awaited<ReturnType<typeof readCurrentSnapshot>>>,
  selectionSize: number,
): Promise<FactorSelectionHistory> {
  const snapshotDir = join(root, current.manifest.snapshotId);
  const barsGlob = normalizePath(join(snapshotDir, 'bars', '**', '*.parquet'));
  const financialPath = normalizePath(join(snapshotDir, 'financial_reports', 'data.parquet'));
  const session = await openManagedDuckDB({
    label: 'factor-stock-selection',
    config: { threads: '4', max_memory: '2GB' },
  });
  try {
    const reader = await session.connection.runAndReadAll(`
      WITH
      all_bars AS (
        SELECT * EXCLUDE(year)
        FROM read_parquet('${escapeSql(barsGlob)}', hive_partitioning=true)
      ),
      listing AS (
        SELECT instrumentKey, min(tradeDate) AS listingDate
        FROM all_bars
        GROUP BY instrumentKey
      ),
      recent_dates AS (
        SELECT tradeDate
        FROM (SELECT DISTINCT tradeDate FROM all_bars)
        ORDER BY tradeDate DESC
        LIMIT ${HISTORY_SESSIONS}
      ),
      latest_prices AS (
        SELECT instrumentKey, close AS latestPrice
        FROM all_bars
        WHERE tradeDate = (SELECT max(tradeDate) FROM recent_dates)
      ),
      rolling_source AS (
        SELECT
          b.instrumentKey, b.market, b.symbol, b.name, b.industry, b.tradeDate,
          b.close, b.turnoverRatePct, b.totalMarketCap,
          avg(b.turnoverRatePct) OVER (
            PARTITION BY b.instrumentKey ORDER BY b.tradeDate
            ROWS BETWEEN 19 PRECEDING AND CURRENT ROW
          ) AS turnover20,
          stddev_samp(b.turnoverRatePct) OVER (
            PARTITION BY b.instrumentKey ORDER BY b.tradeDate
            ROWS BETWEEN 19 PRECEDING AND CURRENT ROW
          ) AS turnoverStd20,
          count(b.turnoverRatePct) OVER (
            PARTITION BY b.instrumentKey ORDER BY b.tradeDate
            ROWS BETWEEN 19 PRECEDING AND CURRENT ROW
          ) AS turnoverObs20
        FROM all_bars b
        WHERE b.tradeDate >= DATE '${recentWindowStart(current.manifest.maxDate)}'
      ),
      eligible AS (
        SELECT r.*, l.listingDate
        FROM rolling_source r
        JOIN recent_dates d USING (tradeDate)
        JOIN listing l USING (instrumentKey)
        WHERE r.market IN ('SH', 'SZ')
          AND r.symbol NOT LIKE '688%'
          AND r.symbol NOT LIKE '689%'
          AND upper(coalesce(r.name, '')) NOT LIKE '%ST%'
          AND r.close > 1.2
          AND date_diff('day', l.listingDate, r.tradeDate) >= 365
          AND r.turnoverObs20 >= 15
          AND r.totalMarketCap > 0
      ),
      fin_raw AS (
        SELECT
          *,
          coalesce(roeWeightedPct, roePct, roeCalculatedPct) AS roeValue,
          coalesce(totalRevenue, revenue) AS revenueValue
        FROM read_parquet('${escapeSql(financialPath)}')
        WHERE announcementDate IS NOT NULL
      ),
      fin_filled AS (
        SELECT
          instrumentKey, announcementDate, reportPeriod, updateFlag, fetchedAt,
          last_value(roeValue IGNORE NULLS) OVER w AS roe,
          last_value(grossMarginPct IGNORE NULLS) OVER w AS grossMargin,
          last_value(operatingCashFlowToRevenuePct IGNORE NULLS) OVER w AS ocfToRevenue,
          last_value(freeCashFlow IGNORE NULLS) OVER w AS freeCashFlow,
          last_value(debtToAssetsPct IGNORE NULLS) OVER w AS debtToAssets,
          last_value(receivablesTurnover IGNORE NULLS) OVER w AS receivablesTurnover,
          last_value(inventoryTurnover IGNORE NULLS) OVER w AS inventoryTurnover,
          last_value(revenueValue IGNORE NULLS) OVER w AS totalRevenue,
          last_value(totalAssets IGNORE NULLS) OVER w AS totalAssets,
          last_value(shortTermBorrowings IGNORE NULLS) OVER w AS shortTermBorrowings,
          last_value(longTermBorrowings IGNORE NULLS) OVER w AS longTermBorrowings,
          last_value(bondsPayable IGNORE NULLS) OVER w AS bondsPayable,
          last_value(cashAndEquivalents IGNORE NULLS) OVER w AS cashAndEquivalents
        FROM fin_raw
        WINDOW w AS (
          PARTITION BY instrumentKey
          ORDER BY announcementDate, reportPeriod, updateFlag, fetchedAt
          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        )
      ),
      fin_daily AS (
        SELECT * EXCLUDE(rn)
        FROM (
          SELECT *, row_number() OVER (
            PARTITION BY instrumentKey, announcementDate
            ORDER BY reportPeriod DESC, updateFlag DESC, fetchedAt DESC
          ) AS rn
          FROM fin_filled
        )
        WHERE rn = 1
      )
      SELECT
        e.instrumentKey, e.market, e.symbol, e.name, e.industry, e.tradeDate,
        e.close, coalesce(lp.latestPrice, e.close) AS latestPrice,
        e.turnoverRatePct AS turnover, e.turnover20, e.turnoverStd20,
        f.announcementDate AS financialAsOf,
        f.roe, f.grossMargin, f.ocfToRevenue,
        CASE
          WHEN e.totalMarketCap + coalesce(f.shortTermBorrowings, 0)
            + coalesce(f.longTermBorrowings, 0) + coalesce(f.bondsPayable, 0)
            - coalesce(f.cashAndEquivalents, 0) > 0
          THEN f.freeCashFlow / (
            e.totalMarketCap + coalesce(f.shortTermBorrowings, 0)
            + coalesce(f.longTermBorrowings, 0) + coalesce(f.bondsPayable, 0)
            - coalesce(f.cashAndEquivalents, 0)
          )
          ELSE NULL
        END AS fcfToEv,
        f.debtToAssets, f.receivablesTurnover, f.inventoryTurnover,
        ln(e.totalMarketCap) AS logMarketCap,
        CASE WHEN f.totalRevenue > 0 THEN ln(f.totalRevenue) ELSE NULL END AS logRevenue,
        CASE WHEN f.totalAssets > 0 THEN ln(f.totalAssets) ELSE NULL END AS logAssets
      FROM eligible e
      LEFT JOIN latest_prices lp USING (instrumentKey)
      ASOF LEFT JOIN fin_daily f
        ON e.instrumentKey = f.instrumentKey
       AND e.tradeDate >= f.announcementDate
      ORDER BY e.tradeDate DESC, e.instrumentKey
    `);
    const raw = reader.getRowObjectsJson().map(toRawRow);
    return assembleHistory(raw, {
      snapshotId: current.manifest.snapshotId,
      snapshotCreatedAt: current.manifest.createdAt,
      dataAsOf: current.manifest.maxDate,
      selectionSize,
    });
  } finally {
    await session.close();
  }
}

export function assembleHistory(
  rows: RawSelectionRow[],
  meta: {
    snapshotId: string;
    snapshotCreatedAt: string;
    dataAsOf: string;
    selectionSize: number;
  },
): FactorSelectionHistory {
  const byDate = new Map<string, RawSelectionRow[]>();
  for (const row of rows) {
    const current = byDate.get(row.tradeDate) ?? [];
    current.push(row);
    byDate.set(row.tradeDate, current);
  }
  const dates = [...byDate.keys()].sort().reverse().slice(0, HISTORY_SESSIONS);
  const latestPrices = new Map(rows.map((row) => [row.instrumentKey, row.latestPrice]));
  const batches = dates.map((tradeDate, dateIndex) => {
    const scored = scoreCrossSection(byDate.get(tradeDate) ?? [])
      .sort((a, b) => b.selectionScore - a.selectionScore || a.row.symbol.localeCompare(b.row.symbol))
      .slice(0, meta.selectionSize);
    const items = scored.map(({ row, selectionScore, factorCount }, index): FactorSelectionItem => {
      const latestPrice = latestPrices.get(row.instrumentKey) ?? row.close;
      return {
        rank: index + 1,
        code: row.symbol,
        name: row.name,
        market: row.market === 'SZ' ? 'SZ' : 'SH',
        industry: row.industry || '未知',
        selectionScore,
        factorCount,
        selectedPrice: row.close,
        latestPrice,
        returnSinceSelectionPct: row.close > 0 ? (latestPrice / row.close - 1) * 100 : 0,
        financialAsOf: row.financialAsOf,
      };
    });
    const averageReturnPct = items.length
      ? items.reduce((sum, item) => sum + item.returnSinceSelectionPct, 0) / items.length
      : 0;
    return {
      tradeDate,
      isLatest: dateIndex === 0,
      averageReturnPct,
      positiveCount: items.filter((item) => item.returnSinceSelectionPct > 0).length,
      items,
    };
  });
  return {
    strategy: '13因子-中性化',
    snapshotId: meta.snapshotId,
    snapshotCreatedAt: meta.snapshotCreatedAt,
    dataAsOf: meta.dataAsOf,
    generatedAt: new Date().toISOString(),
    methodology: {
      factorCount: FACTOR_COUNT,
      minimumFactorCount: MIN_FACTOR_COUNT,
      selectionSize: meta.selectionSize,
      retainedSessions: HISTORY_SESSIONS,
      processing: ['1%/99% 去极值', '横截面标准化', '行业与市值中性化', '缺失因子按 0 分参与等权'],
    },
    batches,
  };
}

function scoreCrossSection(rows: RawSelectionRow[]) {
  const capZ = winsorZ(rows.map((row) => row.values.logMarketCap));
  const factorScores = FACTORS.map((factor) => {
    const base = winsorZ(rows.map((row) => row.values[factor.key]))
      .map((value) => value == null ? null : value * factor.direction);
    return neutralize(base, rows.map((row) => row.industry || '未知'), capZ, factor.capNeutral);
  });
  return rows.map((row, index) => {
    let factorCount = 0;
    let sum = 0;
    for (const scores of factorScores) {
      const value = scores[index];
      if (value != null) {
        factorCount += 1;
        sum += value;
      }
    }
    return { row, factorCount, selectionScore: sum / FACTOR_COUNT };
  }).filter((item) => item.factorCount >= MIN_FACTOR_COUNT);
}

function winsorZ(values: Array<number | null>): Array<number | null> {
  const valid = values.filter((value): value is number => value != null && Number.isFinite(value));
  if (valid.length < 5) return values.map(() => null);
  const sorted = [...valid].sort((a, b) => a - b);
  const lo = quantile(sorted, 0.01);
  const hi = quantile(sorted, 0.99);
  const clipped = values.map((value) => value == null ? null : Math.max(lo, Math.min(hi, value)));
  const finite = clipped.filter((value): value is number => value != null);
  const mean = finite.reduce((sum, value) => sum + value, 0) / finite.length;
  const sd = Math.sqrt(finite.reduce((sum, value) => sum + (value - mean) ** 2, 0) / finite.length);
  if (!Number.isFinite(sd) || sd < 1e-12) return values.map(() => null);
  return clipped.map((value) => value == null ? null : (value - mean) / sd);
}

function neutralize(
  values: Array<number | null>,
  industries: string[],
  capZ: Array<number | null>,
  capNeutral: boolean,
): Array<number | null> {
  const industryValues = new Map<string, number[]>();
  values.forEach((value, index) => {
    if (value == null) return;
    const bucket = industryValues.get(industries[index]) ?? [];
    bucket.push(value);
    industryValues.set(industries[index], bucket);
  });
  const means = new Map([...industryValues].map(([key, bucket]) => [
    key,
    bucket.reduce((sum, value) => sum + value, 0) / bucket.length,
  ]));
  let residuals = values.map((value, index) => (
    value == null ? null : value - (means.get(industries[index]) ?? 0)
  ));
  if (capNeutral) {
    const capIndustryValues = new Map<string, number[]>();
    capZ.forEach((value, index) => {
      if (value == null) return;
      const bucket = capIndustryValues.get(industries[index]) ?? [];
      bucket.push(value);
      capIndustryValues.set(industries[index], bucket);
    });
    const capMeans = new Map([...capIndustryValues].map(([key, bucket]) => [
      key,
      bucket.reduce((sum, value) => sum + value, 0) / bucket.length,
    ]));
    const capDm = capZ.map((value, index) => (
      value == null ? null : value - (capMeans.get(industries[index]) ?? 0)
    ));
    let numerator = 0;
    let denominator = 0;
    residuals.forEach((value, index) => {
      const cap = capDm[index];
      if (value == null || cap == null) return;
      numerator += cap * value;
      denominator += cap * cap;
    });
    if (denominator > 1e-12) {
      const beta = numerator / denominator;
      residuals = residuals.map((value, index) => (
        value == null || capDm[index] == null ? value : value - beta * capDm[index]!
      ));
    }
  }
  const valid = residuals.filter((value): value is number => value != null && Number.isFinite(value));
  if (valid.length < 5) return residuals.map(() => null);
  const mean = valid.reduce((sum, value) => sum + value, 0) / valid.length;
  const sd = Math.sqrt(valid.reduce((sum, value) => sum + (value - mean) ** 2, 0) / valid.length);
  if (!Number.isFinite(sd) || sd < 1e-12) return residuals.map(() => null);
  return residuals.map((value) => value == null ? null : (value - mean) / sd);
}

function quantile(sorted: number[], percentile: number): number {
  const index = (sorted.length - 1) * percentile;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const weight = index - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function toRawRow(value: Record<string, unknown>): RawSelectionRow {
  return {
    instrumentKey: String(value.instrumentKey ?? ''),
    market: String(value.market ?? ''),
    symbol: String(value.symbol ?? ''),
    name: String(value.name ?? ''),
    industry: String(value.industry ?? '未知'),
    tradeDate: String(value.tradeDate ?? '').slice(0, 10),
    close: finite(value.close) ?? 0,
    latestPrice: finite(value.latestPrice) ?? finite(value.close) ?? 0,
    financialAsOf: value.financialAsOf == null ? null : String(value.financialAsOf).slice(0, 10),
    values: Object.fromEntries(FACTORS.map((factor) => [
      factor.key,
      finite(value[factor.key]),
    ])) as Record<FactorKey, number | null>,
  };
}

function finite(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function recentWindowStart(maxDate: string): string {
  const date = new Date(`${maxDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 75);
  return date.toISOString().slice(0, 10);
}

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/');
}

function escapeSql(value: string): string {
  return value.replaceAll("'", "''");
}
