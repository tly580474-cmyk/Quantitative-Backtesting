import { join, resolve } from 'node:path';
import { openManagedDuckDB } from '../research/duckdbRuntime.js';
import { readCurrentSnapshot } from '../research/snapshotManifest.js';

const INDEX_CODE = '000852';
const DEFAULT_SELECTION_SIZE = 200;
const MAX_SELECTION_SIZE = 200;
const HISTORY_MONTHS = 6;

export interface RawCsi1000LowPbRow {
  constituentSnapshotId: string;
  constituentDate: string;
  rebalanceDate: string;
  instrumentKey: string;
  market: string;
  symbol: string;
  name: string;
  industry: string;
  pb: number;
  totalMarketCap: number;
  selectedPrice: number;
  latestPrice: number;
}

export interface Csi1000LowPbSelectionItem {
  rank: number;
  code: string;
  name: string;
  market: 'SH' | 'SZ';
  industry: string;
  pb: number;
  totalMarketCapYi: number;
  portfolioWeightPct: number;
  selectedPrice: number;
  latestPrice: number;
  returnSinceSelectionPct: number;
}

export interface Csi1000LowPbSelectionBatch {
  rebalanceDate: string;
  constituentDate: string;
  constituentSnapshotId: string;
  isLatest: boolean;
  averagePb: number;
  averageReturnPct: number;
  positiveCount: number;
  items: Csi1000LowPbSelectionItem[];
}

export interface Csi1000LowPbSelectionHistory {
  strategy: '中证1000低PB';
  snapshotId: string;
  snapshotCreatedAt: string;
  dataAsOf: string;
  generatedAt: string;
  methodology: {
    indexCode: '000852';
    indexName: '中证1000';
    selectionSize: number;
    retainedMonths: number;
    rebalance: '月末';
    weighting: '等权';
    processing: string[];
    caveats: string[];
  };
  batches: Csi1000LowPbSelectionBatch[];
}

const resultCache = new Map<string, Promise<Csi1000LowPbSelectionHistory>>();

export async function getCsi1000LowPbSelectionHistory(
  snapshotRoot: string,
  options: { force?: boolean; selectionSize?: number } = {},
): Promise<Csi1000LowPbSelectionHistory> {
  const root = resolve(snapshotRoot);
  const current = await readCurrentSnapshot(root);
  if (!current) throw new Error('尚未发布可用的研究快照');
  const selectionSize = Math.max(10, Math.min(MAX_SELECTION_SIZE, Math.trunc(
    options.selectionSize ?? DEFAULT_SELECTION_SIZE,
  )));
  const cacheKey = `${current.manifest.snapshotId}:${selectionSize}`;
  if (options.force) resultCache.delete(cacheKey);
  const cached = resultCache.get(cacheKey);
  if (cached) return cached;
  const task = buildHistory(root, current, selectionSize).catch((error) => {
    resultCache.delete(cacheKey);
    throw error;
  });
  resultCache.set(cacheKey, task);
  return task;
}

async function buildHistory(
  root: string,
  current: NonNullable<Awaited<ReturnType<typeof readCurrentSnapshot>>>,
  selectionSize: number,
): Promise<Csi1000LowPbSelectionHistory> {
  const snapshotDir = join(root, current.manifest.snapshotId);
  const barsGlob = normalizePath(join(snapshotDir, 'bars', '**', '*.parquet'));
  const snapshotDataset = current.manifest.datasets?.find(
    (item) => item.name === 'index_constituent_snapshots',
  );
  const constituentDataset = current.manifest.datasets?.find(
    (item) => item.name === 'index_constituents',
  );
  const adjustmentDataset = current.manifest.datasets?.find(
    (item) => item.name === 'adjustment_factors',
  );
  if (!snapshotDataset || !constituentDataset || !adjustmentDataset) {
    throw new Error('当前研究快照不包含中证1000成分或复权数据');
  }
  const snapshotPath = normalizePath(join(snapshotDir, snapshotDataset.relativePath));
  const constituentPath = normalizePath(join(snapshotDir, constituentDataset.relativePath));
  const adjustmentPath = normalizePath(join(snapshotDir, adjustmentDataset.relativePath));
  const session = await openManagedDuckDB({
    label: 'csi1000-low-pb-selection',
    config: { threads: '4', max_memory: '2GB' },
  });
  try {
    const reader = await session.connection.runAndReadAll(`
      WITH
      all_bars AS (
        SELECT * EXCLUDE(year)
        FROM read_parquet('${escapeSql(barsGlob)}', hive_partitioning=true)
      ),
      adjustment_factors AS (
        SELECT * FROM read_parquet('${escapeSql(adjustmentPath)}')
      ),
      priced_bars AS (
        SELECT
          bar.*,
          bar.close * coalesce(factor.factor, 1) + coalesce(factor.priceOffset, 0)
            AS adjustedClose
        FROM all_bars bar
        ASOF LEFT JOIN adjustment_factors factor
          ON bar.instrumentKey = factor.instrumentKey
         AND bar.tradeDate >= factor.effectiveDate
      ),
      latest_date AS (
        SELECT max(tradeDate) AS dataAsOf FROM priced_bars
      ),
      completed_month_ends AS (
        SELECT max(tradeDate) AS rebalanceDate
        FROM priced_bars, latest_date
        WHERE date_trunc('month', tradeDate) < date_trunc('month', dataAsOf)
        GROUP BY date_trunc('month', tradeDate)
        ORDER BY rebalanceDate DESC
        LIMIT ${HISTORY_MONTHS}
      ),
      constituent_snapshots AS (
        SELECT * FROM read_parquet('${escapeSql(snapshotPath)}')
        WHERE indexCode = '${INDEX_CODE}'
      ),
      rebalance_snapshots AS (
        SELECT
          d.rebalanceDate,
          s.snapshotId,
          s.constituentDate,
          row_number() OVER (
            PARTITION BY d.rebalanceDate
            ORDER BY s.constituentDate DESC, (s.weightDate IS NOT NULL) DESC, s.fetchedAt DESC
          ) AS rn
        FROM completed_month_ends d
        JOIN constituent_snapshots s ON s.constituentDate <= d.rebalanceDate
        QUALIFY rn = 1
      ),
      constituents AS (
        SELECT * FROM read_parquet('${escapeSql(constituentPath)}')
      ),
      lifecycle AS (
        SELECT
          instrumentKey,
          min(tradeDate) AS firstDate,
          arg_max(adjustedClose, tradeDate) FILTER (WHERE adjustedClose > 0) AS latestPrice
        FROM priced_bars
        GROUP BY instrumentKey
      ),
      eligible AS (
        SELECT
          rs.snapshotId AS constituentSnapshotId,
          rs.constituentDate,
          rs.rebalanceDate,
          b.instrumentKey,
          b.market,
          b.symbol,
          b.name,
          b.industry,
          b.pb,
          b.totalMarketCap,
          b.adjustedClose AS selectedPrice,
          coalesce(l.latestPrice, b.adjustedClose) AS latestPrice
        FROM rebalance_snapshots rs
        JOIN constituents c ON c.snapshotId = rs.snapshotId
        JOIN priced_bars b
          ON b.tradeDate = rs.rebalanceDate
         AND b.symbol = c.constituentCode
        JOIN lifecycle l ON l.instrumentKey = b.instrumentKey
        WHERE b.market IN ('SH', 'SZ')
          AND b.pb IS NOT NULL AND b.pb > 0
          AND b.totalMarketCap IS NOT NULL AND b.totalMarketCap > 0
          AND b.adjustedClose IS NOT NULL AND b.adjustedClose > 0
          AND coalesce(b.volume, 0) > 0
          AND upper(coalesce(b.name, '')) NOT LIKE '%ST%'
          AND coalesce(b.name, '') NOT LIKE '%退%'
          AND date_diff('day', l.firstDate, rs.rebalanceDate) >= 180
      )
      SELECT * EXCLUDE(rank)
      FROM (
        SELECT *, row_number() OVER (
          PARTITION BY rebalanceDate ORDER BY pb, symbol
        ) AS rank
        FROM eligible
      )
      WHERE rank <= ${selectionSize}
      ORDER BY rebalanceDate DESC, rank
    `);
    const rows = reader.getRowObjectsJson().map(toRawRow);
    if (!rows.length) throw new Error('中证1000成分覆盖期内没有可用的低PB选股结果');
    return assembleCsi1000LowPbHistory(rows, {
      snapshotId: current.manifest.snapshotId,
      snapshotCreatedAt: current.manifest.createdAt,
      dataAsOf: current.manifest.maxDate,
      selectionSize,
    });
  } finally {
    await session.close();
  }
}

export function assembleCsi1000LowPbHistory(
  rows: RawCsi1000LowPbRow[],
  meta: {
    snapshotId: string;
    snapshotCreatedAt: string;
    dataAsOf: string;
    selectionSize: number;
  },
): Csi1000LowPbSelectionHistory {
  const byDate = new Map<string, RawCsi1000LowPbRow[]>();
  for (const row of rows) {
    const bucket = byDate.get(row.rebalanceDate) ?? [];
    bucket.push(row);
    byDate.set(row.rebalanceDate, bucket);
  }
  const dates = [...byDate.keys()].sort().reverse().slice(0, HISTORY_MONTHS);
  const batches = dates.map((rebalanceDate, dateIndex): Csi1000LowPbSelectionBatch => {
    const selected = [...(byDate.get(rebalanceDate) ?? [])]
      .sort((left, right) => left.pb - right.pb || left.symbol.localeCompare(right.symbol))
      .slice(0, meta.selectionSize);
    const weight = selected.length ? 100 / selected.length : 0;
    const items = selected.map((row, index): Csi1000LowPbSelectionItem => ({
      rank: index + 1,
      code: row.symbol,
      name: row.name,
      market: row.market === 'SZ' ? 'SZ' : 'SH',
      industry: row.industry || '未知',
      pb: row.pb,
      totalMarketCapYi: row.totalMarketCap / 100_000_000,
      portfolioWeightPct: weight,
      selectedPrice: row.selectedPrice,
      latestPrice: row.latestPrice,
      returnSinceSelectionPct: row.selectedPrice > 0
        ? (row.latestPrice / row.selectedPrice - 1) * 100
        : 0,
    }));
    return {
      rebalanceDate,
      constituentDate: selected[0]?.constituentDate ?? rebalanceDate,
      constituentSnapshotId: selected[0]?.constituentSnapshotId ?? '',
      isLatest: dateIndex === 0,
      averagePb: items.length ? items.reduce((sum, item) => sum + item.pb, 0) / items.length : 0,
      averageReturnPct: items.length
        ? items.reduce((sum, item) => sum + item.returnSinceSelectionPct, 0) / items.length
        : 0,
      positiveCount: items.filter((item) => item.returnSinceSelectionPct > 0).length,
      items,
    };
  });
  return {
    strategy: '中证1000低PB',
    snapshotId: meta.snapshotId,
    snapshotCreatedAt: meta.snapshotCreatedAt,
    dataAsOf: meta.dataAsOf,
    generatedAt: new Date().toISOString(),
    methodology: {
      indexCode: INDEX_CODE,
      indexName: '中证1000',
      selectionSize: meta.selectionSize,
      retainedMonths: HISTORY_MONTHS,
      rebalance: '月末',
      weighting: '等权',
      processing: ['锁定月末真实成分快照', '剔除ST/退市/停牌/上市不足180天', '保留正PB', '按PB升序取前200只', '等权配置'],
      caveats: ['结果未计交易成本与冲击成本', '历史回测不代表未来表现', '最大回撤纪律需由投资者独立执行'],
    },
    batches,
  };
}

function toRawRow(value: Record<string, unknown>): RawCsi1000LowPbRow {
  return {
    constituentSnapshotId: String(value.constituentSnapshotId ?? ''),
    constituentDate: String(value.constituentDate ?? '').slice(0, 10),
    rebalanceDate: String(value.rebalanceDate ?? '').slice(0, 10),
    instrumentKey: String(value.instrumentKey ?? ''),
    market: String(value.market ?? ''),
    symbol: String(value.symbol ?? ''),
    name: String(value.name ?? ''),
    industry: String(value.industry ?? '未知'),
    pb: finite(value.pb),
    totalMarketCap: finite(value.totalMarketCap),
    selectedPrice: finite(value.selectedPrice),
    latestPrice: finite(value.latestPrice),
  };
}

function finite(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/');
}

function escapeSql(value: string): string {
  return value.replaceAll("'", "''");
}
