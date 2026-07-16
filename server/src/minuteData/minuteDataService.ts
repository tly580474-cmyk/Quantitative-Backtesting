import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { openManagedDuckDB } from '../research/duckdbRuntime.js';

const manifestFileSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  relativePath: z.string().min(1),
  bytes: z.number().nonnegative(),
  crc32: z.string().regex(/^[0-9a-f]{8}$/i),
  source: z.string().min(1).optional(),
});

const manifestYearSchema = z.object({
  year: z.number().int(),
  sourceZip: z.string(),
  sourceBytes: z.number().nonnegative(),
  sourceModifiedAt: z.string(),
  fileCount: z.number().int().nonnegative(),
  firstDate: z.string().nullable(),
  lastDate: z.string().nullable(),
  parquetBytes: z.number().nonnegative(),
  extractedFiles: z.number().int().nonnegative(),
});

const minuteManifestSchema = z.object({
  schemaVersion: z.literal(1),
  dataset: z.literal('a-share-1m-price'),
  startYear: z.number().int(),
  endYear: z.number().int(),
  preparedAt: z.string(),
  columns: z.array(z.string()),
  years: z.array(manifestYearSchema),
  files: z.array(manifestFileSchema),
});

export type MinuteDataManifest = z.infer<typeof minuteManifestSchema>;

export interface MinuteBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  amount: number;
  previousClose: number | null;
  change: number | null;
  changePct: number | null;
  isTradable: boolean;
}

export interface MinuteQuery {
  code: string;
  startDate: string;
  endDate: string;
  limit: number;
  includeZeroVolume: boolean;
}

let manifestCache: { path: string; modifiedAtMs: number; manifest: MinuteDataManifest } | null = null;

export async function getMinuteDataCatalog(root: string) {
  try {
    const manifest = await readMinuteManifest(root);
    return {
      status: 'ready' as const,
      dataset: manifest.dataset,
      preparedAt: manifest.preparedAt,
      startYear: manifest.startYear,
      endYear: manifest.endYear,
      firstDate: manifest.files[0]?.date ?? null,
      lastDate: manifest.files.at(-1)?.date ?? null,
      tradingDays: manifest.files.length,
      parquetBytes: manifest.years.reduce((sum, year) => sum + year.parquetBytes, 0),
      years: manifest.years.map((year) => ({
        year: year.year,
        fileCount: year.fileCount,
        firstDate: year.firstDate,
        lastDate: year.lastDate,
        parquetBytes: year.parquetBytes,
      })),
    };
  } catch (error) {
    if (isMissingFileError(error)) return { status: 'unavailable' as const };
    throw error;
  }
}

export async function queryMinuteBars(root: string, query: MinuteQuery) {
  const manifest = await readMinuteManifest(root);
  const files = selectMinuteFiles(manifest, query.startDate, query.endDate);
  if (files.length === 0) {
    return {
      providerSymbol: normalizeMinuteProviderSymbol(query.code),
      startDate: query.startDate,
      endDate: query.endDate,
      sourceFiles: 0,
      items: [] as MinuteBar[],
      truncated: false,
      elapsedMs: 0,
    };
  }
  if (files.length > 366) throw new Error('单次分钟查询最多覆盖 366 个交易日');

  const dataRoot = resolve(root);
  const parquetFiles = files.map((file) => normalizeDuckDbPath(resolve(dataRoot, file.relativePath)));
  const built = buildMinuteQuery(parquetFiles, query);
  const session = await openManagedDuckDB({
    label: 'minute-query',
    config: { threads: '4', max_memory: '1GB' },
  });
  try {
    const startedAt = performance.now();
    const reader = await session.connection.runAndReadAll(built.sql, built.values);
    const rows = reader.getRowObjectsJson();
    const items = rows.slice(0, query.limit).map(normalizeMinuteRow);
    return {
      providerSymbol: built.providerSymbol,
      startDate: query.startDate,
      endDate: query.endDate,
      sourceFiles: files.length,
      items,
      truncated: rows.length > query.limit,
      elapsedMs: Math.round((performance.now() - startedAt) * 100) / 100,
    };
  } finally {
    await session.close();
  }
}

export function buildMinuteQuery(
  parquetFiles: string[],
  query: MinuteQuery,
): { sql: string; values: Record<string, string | number>; providerSymbol: string } {
  if (parquetFiles.length === 0) throw new Error('分钟查询至少需要一个 Parquet 文件');
  const providerSymbol = normalizeMinuteProviderSymbol(query.code);
  const fileList = parquetFiles.map((file) => `'${escapeSqlLiteral(file)}'`).join(', ');
  return {
    providerSymbol,
    values: { providerSymbol, limit: query.limit + 1 },
    sql: `
      SELECT trade_time AS date,
             open,
             high,
             low,
             close,
             vol AS volume,
             amount,
             pre_close AS previousClose,
             change,
             pct_chg AS changePct,
             vol > 0 AS isTradable
      FROM read_parquet([${fileList}], union_by_name = true)
      WHERE code = $providerSymbol
        ${query.includeZeroVolume ? '' : 'AND vol > 0'}
      ORDER BY trade_time
      LIMIT $limit
    `,
  };
}

export function normalizeMinuteProviderSymbol(input: string): string {
  const value = input.trim().toUpperCase();
  const suffix = value.match(/^(\d{6})\.(SH|SZ|BJ)$/);
  if (suffix) return `${suffix[1]}.${suffix[2]}`;
  const prefix = value.match(/^(SH|SZ|BJ)(\d{6})$/);
  if (prefix) return `${prefix[2]}.${prefix[1]}`;
  const plain = value.match(/^\d{6}$/)?.[0];
  if (!plain) throw new Error('请输入有效的 6 位 A 股代码');
  const market = /^[48]/.test(plain) || /^92/.test(plain)
    ? 'BJ'
    : /^[69]/.test(plain) ? 'SH' : 'SZ';
  return `${plain}.${market}`;
}

async function readMinuteManifest(root: string): Promise<MinuteDataManifest> {
  const resolvedRoot = resolve(root);
  const path = resolve(resolvedRoot, 'manifest.json');
  const fileStat = await stat(path);
  if (manifestCache?.path === path && manifestCache.modifiedAtMs === fileStat.mtimeMs) {
    return manifestCache.manifest;
  }
  const text = await readFile(path, 'utf8');
  const manifest = minuteManifestSchema.parse(JSON.parse(text));
  manifestCache = { path, modifiedAtMs: fileStat.mtimeMs, manifest };
  return manifest;
}

function selectMinuteFiles(manifest: MinuteDataManifest, startDate: string, endDate: string) {
  if (startDate > endDate) throw new Error('分钟查询开始日期不能晚于结束日期');
  return manifest.files.filter((file) => file.date >= startDate && file.date <= endDate);
}

function normalizeMinuteRow(row: Record<string, unknown>): MinuteBar {
  return {
    date: String(row.date),
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volume: Number(row.volume),
    amount: Number(row.amount),
    previousClose: nullableNumber(row.previousClose),
    change: nullableNumber(row.change),
    changePct: nullableNumber(row.changePct),
    isTradable: Boolean(row.isTradable),
  };
}

function nullableNumber(value: unknown): number | null {
  return value == null ? null : Number(value);
}

function normalizeDuckDbPath(path: string): string {
  return path.replaceAll('\\', '/');
}

function escapeSqlLiteral(value: string): string {
  return value.replaceAll("'", "''");
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: string }).code === 'ENOENT';
}
