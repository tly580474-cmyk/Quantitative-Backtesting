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

const MAX_CONCURRENT_RESEARCH_QUERIES = 2;
const MAX_QUEUED_RESEARCH_QUERIES = 8;
let activeResearchQueries = 0;
const researchQueue: Array<(release: () => void) => void> = [];

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

export async function queryResearchSnapshot(root: string, query: ResearchQuery) {
  const snapshotRoot = resolve(root);
  const current = await readCurrentSnapshot(snapshotRoot);
  if (!current) throw new Error('尚未发布可用的研究快照');
  const parquetGlob = normalizeDuckDbPath(
    join(snapshotRoot, current.manifest.snapshotId, 'bars', 'year=*', '*.parquet'),
  );
  const built = buildResearchQuery(parquetGlob, query);
  const release = await acquireResearchSlot();
  try {
    const session = await openManagedDuckDB({ label: 'research-query',
      config: { threads: '4', max_memory: '1GB' } });
    try {
      const { connection } = session;
      try {
        const startedAt = performance.now();
        const reader = await connection.runAndReadAll(built.sql, built.values);
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
    } finally { await session.close(); }
  } finally {
    release();
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

async function acquireResearchSlot(): Promise<() => void> {
  if (activeResearchQueries < MAX_CONCURRENT_RESEARCH_QUERIES) {
    activeResearchQueries += 1;
    return releaseResearchSlot;
  }
  if (researchQueue.length >= MAX_QUEUED_RESEARCH_QUERIES) {
    throw new Error('研究查询并发已满，请稍后重试');
  }
  return new Promise((resolveSlot) => {
    researchQueue.push(resolveSlot);
  });
}

function releaseResearchSlot(): void {
  const next = researchQueue.shift();
  if (next) {
    next(releaseResearchSlot);
    return;
  }
  activeResearchQueries = Math.max(0, activeResearchQueries - 1);
}
