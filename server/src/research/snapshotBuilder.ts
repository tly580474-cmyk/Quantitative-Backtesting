import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import {
  copyFile,
  link,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import mysql from 'mysql2';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { DuckDBInstance } from '@duckdb/node-api';
import type { EnvConfig } from '../config.js';
import {
  sha256File,
  readCurrentSnapshot,
  validateManifest,
  type CurrentSnapshotPointer,
  type ResearchSnapshotManifest,
  type ResearchSnapshotPartition,
} from './snapshotManifest.js';

const SNAPSHOT_COLUMNS = [
  'instrumentKey',
  'market',
  'symbol',
  'name',
  'industry',
  'tradeDate',
  'open',
  'high',
  'low',
  'close',
  'previousClose',
  'volume',
  'amount',
  'turnoverRatePct',
  'totalMarketCap',
  'floatMarketCap',
  'peTtm',
  'pb',
  'psTtm',
  'volumeRatio',
] as const;

const READ_CSV_COLUMNS = `{
  instrumentKey: 'BIGINT',
  market: 'VARCHAR',
  symbol: 'VARCHAR',
  name: 'VARCHAR',
  industry: 'VARCHAR',
  tradeDate: 'DATE',
  open: 'DOUBLE',
  high: 'DOUBLE',
  low: 'DOUBLE',
  close: 'DOUBLE',
  previousClose: 'DOUBLE',
  volume: 'BIGINT',
  amount: 'DOUBLE',
  turnoverRatePct: 'DOUBLE',
  totalMarketCap: 'DOUBLE',
  floatMarketCap: 'DOUBLE',
  peTtm: 'DOUBLE',
  pb: 'DOUBLE',
  psTtm: 'DOUBLE',
  volumeRatio: 'DOUBLE'
}`;

interface SnapshotSourceSummary extends RowDataPacket {
  rowsCount: number | string;
  instrumentCount: number | string;
  minDate: string;
  maxDate: string;
  minYear: number;
  maxYear: number;
}

interface SourceVersionRow extends RowDataPacket {
  sourceVersion: string;
  sourcePublishedAt: string | null;
}

interface SourceYearSummary extends RowDataPacket {
  year: number;
  rowsCount: number | string;
  minDate: string;
  maxDate: string;
}

interface SourceDateSummary extends RowDataPacket {
  tradeDate: string;
  year: number;
  rowsCount: number | string;
}

export interface BuildResearchSnapshotOptions {
  root: string;
  years?: number[];
  snapshotId?: string;
  full?: boolean;
  onProgress?: (message: string) => void;
}

interface RebuildPlan {
  rebuildYears: number[];
  appendDates: SourceDateSummary[];
}

export async function buildResearchSnapshot(
  pool: Pool,
  config: EnvConfig,
  options: BuildResearchSnapshotOptions,
): Promise<ResearchSnapshotManifest> {
  const root = resolve(options.root);
  const onProgress = options.onProgress ?? (() => undefined);
  const [summaryRows] = await pool.query<SnapshotSourceSummary[]>(`
    SELECT COUNT(*) AS rowsCount,
           COUNT(DISTINCT instrument_key) AS instrumentCount,
           DATE_FORMAT(MIN(trade_date), '%Y-%m-%d') AS minDate,
           DATE_FORMAT(MAX(trade_date), '%Y-%m-%d') AS maxDate,
           YEAR(MIN(trade_date)) AS minYear,
           YEAR(MAX(trade_date)) AS maxYear
    FROM daily_bars_v2
  `);
  const summary = summaryRows[0];
  if (!summary || Number(summary.rowsCount) === 0) {
    throw new Error('daily_bars_v2 为空，不能生成研究快照');
  }
  const [versionRows] = await pool.query<SourceVersionRow[]>(`
    SELECT id AS sourceVersion,
           DATE_FORMAT(published_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS sourcePublishedAt
    FROM data_import_batches
    WHERE published_at IS NOT NULL
    ORDER BY published_at DESC
    LIMIT 1
  `);
  const sourceVersion = versionRows[0]?.sourceVersion ?? 'unversioned-v2';
  const snapshotId = options.snapshotId
    ?? `${sourceVersion}-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`;
  const staging = join(root, `.building-${snapshotId}-${randomUUID().slice(0, 8)}`);
  const allYears = range(summary.minYear, summary.maxYear);
  const current = await readCurrentSnapshot(root);
  if (options.years?.length && !current && !options.full) {
    throw new Error('增量重建需要一个已发布的完整研究快照');
  }
  const plan = await resolveRebuildPlan(pool, allYears, current?.manifest ?? null, Number(summary.rowsCount), options);
  const rebuildYears = plan.rebuildYears;
  if (!options.full && current && rebuildYears.length === 0 && plan.appendDates.length === 0) {
    onProgress('当前研究快照已与 MySQL 年度摘要一致，无需生成新快照');
    return current.manifest;
  }
  onProgress(
    rebuildYears.length === allYears.length
      ? '将重建全部年度分区'
      : [
        rebuildYears.length ? `将重建 ${rebuildYears.join(', ')} 年分区` : null,
        plan.appendDates.length ? `将追加 ${plan.appendDates.map((item) => item.tradeDate).join(', ')} 日级分区` : null,
        '其余分区使用硬链接复用',
      ].filter(Boolean).join('，'),
  );

  await mkdir(staging, { recursive: true });
  let readyToPublish = false;
  try {
    const partitions: ResearchSnapshotPartition[] = [];
    for (const year of allYears) {
      const existingPartitions = current?.manifest.partitions.filter(
        (partition) => partition.year === year,
      ) ?? [];
      if (!rebuildYears.includes(year) && existingPartitions.length > 0) {
        for (const existingPartition of existingPartitions) {
          const sourcePath = join(
            root,
            current!.manifest.snapshotId,
            existingPartition.relativePath,
          );
          const targetPath = join(staging, existingPartition.relativePath);
          await mkdir(dirname(targetPath), { recursive: true });
          await linkOrCopyFile(sourcePath, targetPath);
          partitions.push(existingPartition);
        }
        onProgress(`${year} 年硬链接复用 ${existingPartitions.length} 个已校验分区`);
        for (const date of plan.appendDates.filter((item) => item.year === year)) {
          onProgress(`导出 ${date.tradeDate} MySQL 数据`);
          const partitionDir = join(staging, 'bars', `year=${year}`);
          await mkdir(partitionDir, { recursive: true });
          const tsvPath = join(staging, `date-${date.tradeDate}.tsv`);
          const parquetPath = join(partitionDir, `date=${date.tradeDate}.parquet`);
          await streamDateToTsv(config, date.tradeDate, tsvPath);
          onProgress(`压缩 ${date.tradeDate} Parquet`);
          await convertTsvToParquet(tsvPath, parquetPath);
          await rm(tsvPath, { force: true });
          const partition = await inspectPartition(parquetPath, staging, year);
          partitions.push(partition);
          onProgress(`${date.tradeDate} 完成：${partition.rows.toLocaleString()} 行`);
        }
        continue;
      }
      onProgress(`导出 ${year} 年 MySQL 数据`);
      const partitionDir = join(staging, 'bars', `year=${year}`);
      await mkdir(partitionDir, { recursive: true });
      const tsvPath = join(staging, `year-${year}.tsv`);
      const parquetPath = join(partitionDir, 'data.parquet');
      await streamRangeToTsv(config, `${year}-01-01`, `${year + 1}-01-01`, tsvPath);
      onProgress(`压缩 ${year} 年 Parquet`);
      await convertTsvToParquet(tsvPath, parquetPath);
      await rm(tsvPath, { force: true });
      const partition = await inspectPartition(parquetPath, staging, year);
      if (partition.rows > 0) partitions.push(partition);
      else await rm(partitionDir, { recursive: true, force: true });
      onProgress(`${year} 年完成：${partition.rows.toLocaleString()} 行`);
    }

    const rowCount = partitions.reduce((sum, partition) => sum + partition.rows, 0);
    const expectedRows = Number(summary.rowsCount);
    if (rowCount !== expectedRows) {
      throw new Error(`快照行数校验失败：MySQL=${expectedRows}, Parquet=${rowCount}`);
    }
    const manifest: ResearchSnapshotManifest = {
      schemaVersion: 1,
      snapshotId,
      sourceVersion,
      sourcePublishedAt: versionRows[0]?.sourcePublishedAt ?? null,
      createdAt: new Date().toISOString(),
      status: 'validated',
      rowCount,
      instrumentCount: Number(summary.instrumentCount),
      minDate: partitions[0]?.minDate ?? summary.minDate,
      maxDate: partitions.at(-1)?.maxDate ?? summary.maxDate,
      partitions,
    };
    await writeJsonAtomic(join(staging, 'manifest.json'), manifest);
    readyToPublish = true;
    await publishStagedResearchSnapshot(root, staging);
    onProgress(`研究快照已发布：${snapshotId}`);
    return manifest;
  } catch (error) {
    if (!readyToPublish) {
      await rm(staging, { recursive: true, force: true });
    }
    throw error;
  }
}

async function resolveRebuildPlan(
  pool: Pool,
  allYears: number[],
  current: ResearchSnapshotManifest | null,
  sourceRowCount: number,
  options: BuildResearchSnapshotOptions,
): Promise<RebuildPlan> {
  if (options.full || !current) return { rebuildYears: allYears, appendDates: [] };
  if (options.years?.length) {
    return { rebuildYears: [...new Set(options.years)].sort(), appendDates: [] };
  }

  if (current.maxDate && sourceRowCount >= current.rowCount) {
    const appendDates = await readSourceDatesAfter(pool, current.maxDate);
    const appendedRows = appendDates.reduce((sum, item) => sum + Number(item.rowsCount), 0);
    if (appendDates.length > 0 && current.rowCount + appendedRows === sourceRowCount) {
      return { rebuildYears: [], appendDates };
    }
  }

  const [sourceRows] = await pool.query<SourceYearSummary[]>(`
    SELECT YEAR(trade_date) AS year,
           COUNT(*) AS rowsCount,
           DATE_FORMAT(MIN(trade_date), '%Y-%m-%d') AS minDate,
           DATE_FORMAT(MAX(trade_date), '%Y-%m-%d') AS maxDate
    FROM daily_bars_v2
    GROUP BY YEAR(trade_date)
    ORDER BY year
  `);
  const sourceByYear = new Map(
    sourceRows.map((row) => [Number(row.year), {
      rows: Number(row.rowsCount),
      minDate: row.minDate,
      maxDate: row.maxDate,
    }]),
  );
  return {
    rebuildYears: allYears.filter((year) => {
      const source = sourceByYear.get(year);
      const partitions = current.partitions.filter((item) => item.year === year);
      if (!source || partitions.length === 0) return true;
      const rows = partitions.reduce((sum, item) => sum + item.rows, 0);
      const minDate = partitions[0]?.minDate;
      const maxDate = partitions.at(-1)?.maxDate;
      return rows !== source.rows || minDate !== source.minDate || maxDate !== source.maxDate;
    }),
    appendDates: [],
  };
}

async function readSourceDatesAfter(pool: Pool, afterDate: string): Promise<SourceDateSummary[]> {
  const [rows] = await pool.query<SourceDateSummary[]>(`
    SELECT DATE_FORMAT(trade_date, '%Y-%m-%d') AS tradeDate,
           YEAR(trade_date) AS year,
           COUNT(*) AS rowsCount
    FROM daily_bars_v2
    WHERE trade_date > ?
    GROUP BY trade_date
    ORDER BY trade_date
  `, [afterDate]);
  return rows;
}

export async function publishStagedResearchSnapshot(
  rootInput: string,
  stagingInput: string,
): Promise<CurrentSnapshotPointer> {
  const root = resolve(rootInput);
  const staging = resolve(stagingInput);
  const relativeStaging = relative(root, staging);
  if (
    relativeStaging.startsWith('..')
    || relativeStaging.includes(':')
    || !basename(staging).startsWith('.building-')
  ) {
    throw new Error('暂存快照目录不在研究快照根目录内');
  }
  const manifest = JSON.parse(
    await readFile(join(staging, 'manifest.json'), 'utf8'),
  ) as ResearchSnapshotManifest;
  const pointer: CurrentSnapshotPointer = {
    snapshotId: manifest.snapshotId,
    publishedAt: new Date().toISOString(),
  };
  validateManifest(pointer, manifest);
  const finalRoot = join(root, manifest.snapshotId);
  try {
    await materializeImmutableDirectory(staging, finalRoot);
    await rm(staging, { recursive: true, force: true });
    await writeJsonAtomic(join(root, 'current.json'), pointer);
    return pointer;
  } catch (error) {
    await rm(finalRoot, { recursive: true, force: true });
    throw error;
  }
}

async function streamDateToTsv(
  config: EnvConfig,
  tradeDate: string,
  outputPath: string,
): Promise<void> {
  await streamRangeToTsv(config, tradeDate, nextDate(tradeDate), outputPath);
}

async function streamRangeToTsv(
  config: EnvConfig,
  startDate: string,
  endDateExclusive: string,
  outputPath: string,
): Promise<void> {
  const connection = mysql.createConnection({
    host: config.DB_HOST,
    port: parseInt(config.DB_PORT, 10),
    user: config.DB_USER,
    password: config.DB_PASSWORD,
    database: config.DB_NAME,
    charset: 'utf8mb4',
  });
  const query = connection.query(`
    SELECT bar.instrument_key AS instrumentKey,
           instrument.market,
           instrument.symbol,
           instrument.name,
           instrument.industry,
           DATE_FORMAT(bar.trade_date, '%Y-%m-%d') AS tradeDate,
           bar.open,
           bar.high,
           bar.low,
           bar.close,
           bar.previous_close AS previousClose,
           bar.volume,
           bar.amount,
           bar.turnover_rate_pct AS turnoverRatePct,
           metric.total_market_cap AS totalMarketCap,
           metric.float_market_cap AS floatMarketCap,
           metric.pe_ttm AS peTtm,
           metric.pb,
           metric.ps_ttm AS psTtm,
           metric.volume_ratio AS volumeRatio
    FROM daily_bars_v2 AS bar
    INNER JOIN instruments AS instrument
      ON instrument.instrument_key = bar.instrument_key
    LEFT JOIN daily_stock_metrics AS metric
      ON metric.instrument_key = bar.instrument_key
     AND metric.trade_date = bar.trade_date
    WHERE bar.trade_date >= ?
      AND bar.trade_date < ?
    ORDER BY bar.trade_date, bar.instrument_key
  `, [startDate, endDateExclusive]);
  let wroteHeader = false;
  const encoder = new Transform({
    writableObjectMode: true,
    transform(row: Record<string, unknown>, _encoding, callback) {
      const prefix = wroteHeader ? '' : `${SNAPSHOT_COLUMNS.join('\t')}\n`;
      wroteHeader = true;
      callback(null, prefix + SNAPSHOT_COLUMNS.map((column) => encodeTsv(row[column])).join('\t') + '\n');
    },
    flush(callback) {
      if (!wroteHeader) this.push(`${SNAPSHOT_COLUMNS.join('\t')}\n`);
      callback();
    },
  });
  try {
    await pipeline(
      query.stream({ highWaterMark: 2048 }),
      encoder,
      createWriteStream(outputPath),
    );
  } finally {
    connection.end();
  }
}

function nextDate(tradeDate: string): string {
  const date = new Date(`${tradeDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

async function convertTsvToParquet(tsvPath: string, parquetPath: string): Promise<void> {
  const instance = await DuckDBInstance.create(':memory:', { threads: '4' });
  const connection = await instance.connect();
  try {
    await connection.run(`
      COPY (
        SELECT *
        FROM read_csv(
          '${escapeSqlPath(tsvPath)}',
          header = true,
          delim = '\t',
          quote = '"',
          escape = '"',
          nullstr = '\\N',
          auto_detect = false,
          columns = ${READ_CSV_COLUMNS}
        )
      )
      TO '${escapeSqlPath(parquetPath)}'
      (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 122880)
    `);
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

async function inspectPartition(
  parquetPath: string,
  snapshotRoot: string,
  year: number,
): Promise<ResearchSnapshotPartition> {
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  try {
    const reader = await connection.runAndReadAll(`
      SELECT COUNT(*) AS rows,
             CAST(MIN(tradeDate) AS VARCHAR) AS minDate,
             CAST(MAX(tradeDate) AS VARCHAR) AS maxDate
      FROM read_parquet('${escapeSqlPath(parquetPath)}')
    `);
    const row = reader.getRowObjectsJson()[0] as Record<string, unknown> | undefined;
    const fileStat = await stat(parquetPath);
    return {
      year,
      relativePath: relative(snapshotRoot, parquetPath).replaceAll('\\', '/'),
      rows: Number(row?.rows ?? 0),
      bytes: fileStat.size,
      minDate: String(row?.minDate ?? `${year}-01-01`),
      maxDate: String(row?.maxDate ?? `${year}-12-31`),
      sha256: await sha256File(parquetPath),
    };
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, path);
}

function encodeTsv(value: unknown): string {
  if (value === null || value === undefined) return '\\N';
  const text = String(value);
  if (!/[\t\r\n"]/.test(text)) return text;
  return `"${text.replaceAll('"', '""')}"`;
}

function escapeSqlPath(path: string): string {
  return resolve(path).replaceAll('\\', '/').replaceAll("'", "''");
}

function range(start: number, end: number): number[] {
  return Array.from({ length: Math.max(0, end - start + 1) }, (_, index) => start + index);
}

async function materializeImmutableDirectory(source: string, target: string): Promise<void> {
  await mkdir(target, { recursive: false });
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = join(source, entry.name);
    const targetPath = join(target, entry.name);
    if (entry.isDirectory()) {
      await materializeImmutableDirectory(sourcePath, targetPath);
      continue;
    }
    if (!entry.isFile()) continue;
    try {
      await linkOrCopyFile(sourcePath, targetPath);
    } catch (error) {
      await rm(targetPath, { force: true });
      throw error;
    }
  }
}

async function linkOrCopyFile(sourcePath: string, targetPath: string): Promise<void> {
  try {
    await link(sourcePath, targetPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EXDEV' && code !== 'EPERM' && code !== 'EACCES') throw error;
    await copyFile(sourcePath, targetPath);
  }
}
