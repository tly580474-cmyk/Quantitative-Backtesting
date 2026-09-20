import { join, resolve } from 'node:path';
import { readCurrentSnapshot } from './snapshotManifest.js';
import { openManagedDuckDB } from './duckdbRuntime.js';

const FIELD_SQL = {
  instrumentKey: 'instrumentKey',
  market: 'market',
  symbol: 'symbol',
  name: 'name',
  industry: 'industry',
  tradeDate: 'tradeDate',
  open: 'open',
  high: 'high',
  low: 'low',
  close: 'close',
  previousClose: 'previousClose',
  volume: 'volume',
  amount: 'amount',
  turnoverRatePct: 'turnoverRatePct',
  totalMarketCap: 'totalMarketCap',
  floatMarketCap: 'floatMarketCap',
  peTtm: 'peTtm',
  pb: 'pb',
  psTtm: 'psTtm',
  volumeRatio: 'volumeRatio',
} as const;

export type ResearchField = keyof typeof FIELD_SQL;

export interface ResearchQuery {
  startDate: string;
  endDate: string;
  fields: string[];
  markets?: string[];
  symbols?: string[];
  limit: number;
}

export interface BuiltResearchQuery {
  sql: string;
  values: Record<string, string | number>;
  fields: ResearchField[];
}

export async function getCurrentResearchSnapshot(root: string) {
  const current = await readCurrentSnapshot(resolve(root));
  if (!current) return null;
  return {
    status: current.manifest.status,
    snapshotId: current.manifest.snapshotId,
    sourceVersion: current.manifest.sourceVersion,
    sourcePublishedAt: current.manifest.sourcePublishedAt,
    publishedAt: current.pointer.publishedAt,
    rowCount: current.manifest.rowCount,
    instrumentCount: current.manifest.instrumentCount,
    minDate: current.manifest.minDate,
    maxDate: current.manifest.maxDate,
    partitions: current.manifest.partitions.length,
  };
}

export async function queryStockDividendHistory(
  root: string,
  symbol: string,
  limit = 20,
): Promise<Array<Record<string, unknown>>> {
  const snapshotRoot = resolve(root);
  const current = await readCurrentSnapshot(snapshotRoot);
  if (!current) return [];
  const dataset = current.manifest.datasets?.find((item) => item.name === 'dividend_events');
  if (!dataset) return [];
  const parquetPath = normalizeDuckDbPath(
    join(snapshotRoot, current.manifest.snapshotId, dataset.relativePath),
  );
  const session = await openManagedDuckDB({
    label: 'stock-dividend-history',
    config: { threads: '2', max_memory: '256MB' },
  });
  try {
    const reader = await session.connection.runAndReadAll(`
      SELECT reportPeriod, disclosureDate, announcementDate, recordDate, exDate,
             latestAnnouncementDate, cashDividendPerShare, dividendYieldRaw,
             planStatus, rawPlan, sourceKey, fetchedAt
      FROM read_parquet('${escapeSqlLiteral(parquetPath)}')
      WHERE symbol = $symbol
      ORDER BY COALESCE(exDate, latestAnnouncementDate, announcementDate, reportPeriod) DESC
      LIMIT $limit
    `, {
      symbol: symbol.replace(/\D/g, '').padStart(6, '0').slice(-6),
      limit: Math.max(1, Math.min(100, Math.trunc(limit))),
    });
    return reader.getRowObjectsJson().map((row) => row as Record<string, unknown>);
  } finally {
    await session.close();
  }
}

export interface IndexConstituentSnapshot {
  indexCode: string;
  indexName: string;
  constituentDate: string;
  weightDate: string | null;
  source: string;
  total: number;
  updatedAt: string;
  items: Array<{
    rank: number;
    code: string;
    name: string;
    nameEn: string | null;
    exchange: string | null;
    weightPct: number | null;
  }>;
}

export async function queryLatestIndexConstituents(
  root: string,
  inputCode: string,
): Promise<IndexConstituentSnapshot | null> {
  const code = inputCode.replace(/\D/g, '').padStart(6, '0').slice(-6);
  const snapshotRoot = resolve(root);
  const current = await readCurrentSnapshot(snapshotRoot);
  if (!current) return null;
  const dataset = current.manifest.datasets?.find((item) => item.name === 'index_constituents');
  if (!dataset) return null;
  const parquetPath = normalizeDuckDbPath(
    join(snapshotRoot, current.manifest.snapshotId, dataset.relativePath),
  );
  const session = await openManagedDuckDB({
    label: 'index-constituents',
    config: { threads: '2', max_memory: '512MB' },
  });
  try {
    const reader = await session.connection.runAndReadAll(`
      WITH latest_snapshot AS (
        SELECT snapshotId, indexCode, indexName, constituentDate, weightDate, sourceKey
        FROM read_parquet('${escapeSqlLiteral(parquetPath)}')
        WHERE indexCode = $indexCode
        QUALIFY ROW_NUMBER() OVER (
          ORDER BY constituentDate DESC, weightDate DESC NULLS LAST, snapshotId DESC
        ) = 1
      )
      SELECT member.indexCode, member.indexName, member.constituentDate, member.weightDate,
             member.sourceKey, member.constituentCode, member.constituentName,
             member.constituentNameEn, member.exchange, member.weightPct
      FROM read_parquet('${escapeSqlLiteral(parquetPath)}') AS member
      INNER JOIN latest_snapshot AS latest ON member.snapshotId = latest.snapshotId
      ORDER BY member.weightPct DESC NULLS LAST, member.constituentCode
    `, { indexCode: code });
    const rows = reader.getRowObjectsJson() as Array<Record<string, unknown>>;
    if (!rows.length) return null;
    const first = rows[0];
    return {
      indexCode: String(first.indexCode ?? code),
      indexName: String(first.indexName ?? code),
      constituentDate: String(first.constituentDate ?? ''),
      weightDate: first.weightDate == null ? null : String(first.weightDate),
      source: '本地研究快照',
      total: rows.length,
      updatedAt: current.pointer.publishedAt,
      items: rows.map((row, index) => ({
        rank: index + 1,
        code: String(row.constituentCode ?? ''),
        name: String(row.constituentName ?? ''),
        nameEn: row.constituentNameEn == null ? null : String(row.constituentNameEn),
        exchange: row.exchange == null ? null : String(row.exchange),
        weightPct: finiteNumber(row.weightPct),
      })),
    };
  } finally {
    await session.close();
  }
}

export async function queryResearchSnapshot(root: string, query: ResearchQuery) {
  const snapshotRoot = resolve(root);
  const current = await readCurrentSnapshot(snapshotRoot);
  if (!current) throw new Error('尚未发布可用的研究快照');
  const parquetGlob = normalizeDuckDbPath(
    join(snapshotRoot, current.manifest.snapshotId, 'bars', 'year=*', '*.parquet'),
  );
  const built = buildResearchQuery(parquetGlob, query);
  const session = await openManagedDuckDB({
    label: 'research-query',
    config: { threads: '4', max_memory: '1GB' },
  });
  try {
    const startedAt = performance.now();
    const reader = await session.connection.runAndReadAll(built.sql, built.values);
    const rows = reader.getRowObjectsJson();
    return {
      snapshotId: current.manifest.snapshotId,
      sourceVersion: current.manifest.sourceVersion,
      fields: built.fields,
      items: rows.slice(0, query.limit),
      elapsedMs: Math.round((performance.now() - startedAt) * 100) / 100,
      truncated: rows.length > query.limit,
    };
  } finally {
    await session.close();
  }
}

export async function benchmarkResearchSnapshot(
  root: string,
  startDate: string,
  endDate: string,
) {
  const snapshotRoot = resolve(root);
  const current = await readCurrentSnapshot(snapshotRoot);
  if (!current) throw new Error('尚未发布可用的研究快照');
  const parquetGlob = normalizeDuckDbPath(
    join(snapshotRoot, current.manifest.snapshotId, 'bars', 'year=*', '*.parquet'),
  );
  const session = await openManagedDuckDB({ label: 'research-benchmark', config: { threads: '4' } });
  const { connection } = session;
  try {
    const startedAt = performance.now();
    const reader = await connection.runAndReadAll(`
      SELECT COUNT(*) AS rows,
             COUNT(DISTINCT instrumentKey) AS instruments,
             AVG(close) AS averageClose,
             SUM(volume) AS totalVolume
      FROM read_parquet('${escapeSqlLiteral(parquetGlob)}', hive_partitioning = true)
      WHERE tradeDate BETWEEN $startDate AND $endDate
    `, { startDate, endDate });
    return {
      snapshotId: current.manifest.snapshotId,
      startDate,
      endDate,
      result: reader.getRowObjectsJson()[0],
      elapsedMs: Math.round((performance.now() - startedAt) * 100) / 100,
    };
  } finally {
    await session.close();
  }
}

export function buildResearchQuery(
  parquetGlob: string,
  query: ResearchQuery,
): BuiltResearchQuery {
  const fields = [...new Set(query.fields)] as ResearchField[];
  if (fields.length === 0) throw new Error('至少选择一个研究字段');
  for (const field of fields) {
    if (!(field in FIELD_SQL)) throw new Error(`不支持的研究字段：${field}`);
  }

  const values: Record<string, string | number> = {
    startDate: query.startDate,
    endDate: query.endDate,
    limit: query.limit + 1,
  };
  const conditions = ['tradeDate BETWEEN $startDate AND $endDate'];
  if (query.markets?.length) {
    const placeholders = query.markets.map((market, index) => {
      values[`market${index}`] = market;
      return `$market${index}`;
    });
    conditions.push(`market IN (${placeholders.join(', ')})`);
  }
  if (query.symbols?.length) {
    const placeholders = query.symbols.map((symbol, index) => {
      values[`symbol${index}`] = symbol;
      return `$symbol${index}`;
    });
    conditions.push(`symbol IN (${placeholders.join(', ')})`);
  }

  return {
    fields,
    values,
    sql: `
      SELECT ${fields.map((field) => FIELD_SQL[field]).join(', ')}
      FROM read_parquet('${escapeSqlLiteral(parquetGlob)}', hive_partitioning = true)
      WHERE ${conditions.join(' AND ')}
      ORDER BY tradeDate, instrumentKey
      LIMIT $limit
    `,
  };
}

function normalizeDuckDbPath(path: string): string {
  return path.replaceAll('\\', '/');
}

function escapeSqlLiteral(value: string): string {
  return value.replaceAll("'", "''");
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
