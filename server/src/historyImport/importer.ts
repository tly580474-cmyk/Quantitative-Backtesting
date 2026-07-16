import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import {
  assertHistoryHeader,
  inferInstrumentStatus,
  inferMarket,
  isValidOhlc,
  normalizeHistoryRecord,
  parseHistoryRecord,
  type NormalizedHistoryRow,
} from './csv.js';

export interface HistoryImportOptions {
  sourceRoot: string;
  codes?: string[];
  limit?: number;
  chunkRows?: number;
  fallbackBatchRows?: number;
  requireLocalInfile?: boolean;
  dryRun?: boolean;
  batchId?: string;
  cacheRoot: string;
  onProgress?: (progress: HistoryImportProgress) => void;
}

export interface HistoryImportProgress {
  batchId: string;
  completedFiles: number;
  totalFiles: number;
  importedRows: number;
  currentFile: string;
  status: 'scanning' | 'importing' | 'skipped' | 'failed' | 'completed';
}

export interface CsvFileSummary {
  path: string;
  relativePath: string;
  code: string;
  checksum: string;
  rows: number;
  minDate: string | null;
  maxDate: string | null;
  latestRow: NormalizedHistoryRow | null;
  warnings: Array<{ lineNumber: number; tradeDate: string; message: string }>;
}

interface ExistingFileRow extends RowDataPacket {
  status: string;
  checksum: string;
  imported_rows: number;
}

interface InstrumentKeyRow extends RowDataPacket {
  id: string;
  instrument_key: number;
}

interface ExistingBatchRow extends RowDataPacket {
  source_snapshot: string;
}

const DEFAULT_CHUNK_ROWS = 50_000;
const SOURCE_DIRECTORY = '不复权';
let localInfileAvailable = true;
let fallbackUsed = false;
let localInfileUsed = false;

export async function discoverHistoryFiles(options: HistoryImportOptions): Promise<string[]> {
  const directory = resolve(options.sourceRoot, SOURCE_DIRECTORY);
  const names = (await readdir(directory))
    .filter((name) => /^\d{6}\.csv$/.test(name))
    .sort();
  const requested = options.codes?.length
    ? new Set(options.codes.map((code) => code.padStart(6, '0')))
    : null;
  const selected = requested
    ? names.filter((name) => requested.has(name.slice(0, 6)))
    : names;
  return selected
    .slice(0, options.limit && options.limit > 0 ? options.limit : undefined)
    .map((name) => join(directory, name));
}

export async function scanHistoryFile(
  filePath: string,
  sourceRoot: string,
): Promise<CsvFileSummary> {
  const checksumPromise = sha256File(filePath);
  const code = basename(filePath, '.csv');
  const input = createReadStream(filePath, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let lineNumber = 0;
  let rows = 0;
  let minDate: string | null = null;
  let maxDate: string | null = null;
  let previousDate: string | null = null;
  let latestRow: NormalizedHistoryRow | null = null;
  const warnings: CsvFileSummary['warnings'] = [];

  for await (const line of lines) {
    lineNumber += 1;
    if (lineNumber === 1) {
      assertHistoryHeader(line);
      continue;
    }
    if (!line.trim()) continue;
    try {
      const normalized = normalizeHistoryRecord(
        parseHistoryRecord(line),
        { allowInvalidOhlc: true },
      );
      if (!isValidOhlc(normalized)) {
        warnings.push({
          lineNumber,
          tradeDate: normalized.tradeDate,
          message: `${normalized.tradeDate} OHLC 关系无效`,
        });
      }
      if (normalized.code !== code) {
        throw new Error(`文件代码 ${code} 与行代码 ${normalized.code} 不一致`);
      }
      if (previousDate !== null && normalized.tradeDate <= previousDate) {
        throw new Error(`日期重复或未严格升序：${previousDate} → ${normalized.tradeDate}`);
      }
      latestRow = normalized;
      minDate ??= normalized.tradeDate;
      maxDate = normalized.tradeDate;
      previousDate = normalized.tradeDate;
      rows += 1;
    } catch (error) {
      throw new Error(
        `${basename(filePath)} 第 ${lineNumber} 行：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (lineNumber === 0) throw new Error(`${basename(filePath)} 是空文件`);

  return {
    path: resolve(filePath),
    relativePath: relative(resolve(sourceRoot), resolve(filePath)).replaceAll('\\', '/'),
    code,
    checksum: await checksumPromise,
    rows,
    minDate,
    maxDate,
    latestRow,
    warnings,
  };
}

export async function importStockHistory(
  pool: Pool | null,
  options: HistoryImportOptions,
): Promise<{
  batchId: string;
  files: number;
  completedFiles: number;
  importedRows: number;
  failedFiles: number;
  dryRun: boolean;
  importMode: 'dry_run' | 'local_infile' | 'batched_replace' | 'mixed';
}> {
  const files = await discoverHistoryFiles(options);
  if (files.length === 0) throw new Error('没有找到待导入的不复权 CSV');
  const batchId = options.batchId ?? randomUUID();
  const sourceRoot = resolve(options.sourceRoot);
  const snapshot = await buildSourceSnapshot(files, sourceRoot);
  const chunkRows = Math.max(1_000, options.chunkRows ?? DEFAULT_CHUNK_ROWS);

  if (options.dryRun) {
    let rows = 0;
    for (const [index, file] of files.entries()) {
      const summary = await scanHistoryFile(file, sourceRoot);
      rows += summary.rows;
      options.onProgress?.({
        batchId,
        completedFiles: index + 1,
        totalFiles: files.length,
        importedRows: rows,
        currentFile: summary.relativePath,
        status: 'scanning',
      });
    }
    return {
      batchId,
      files: files.length,
      completedFiles: files.length,
      importedRows: rows,
      failedFiles: 0,
      dryRun: true,
      importMode: 'dry_run',
    };
  }
  if (!pool) throw new Error('正式导入需要 MySQL 连接池');
  localInfileAvailable = await detectLocalInfile(pool);
  fallbackUsed = false;
  localInfileUsed = false;
  if (!localInfileAvailable && options.requireLocalInfile) {
    throw new Error(
      'MySQL local_infile=OFF，但本次导入要求 --require-local-infile；'
      + '请启用受控 LOCAL INFILE 后重试。',
    );
  }
  if (!localInfileAvailable) {
    console.warn('\n[history-import] MySQL local_infile=OFF，将使用可审计的批量 REPLACE 降级路径。');
  }

  await recoverFailedImportFiles(pool);
  await upsertBatch(pool, batchId, sourceRoot, snapshot, files.length);
  let completedFiles = 0;
  let importedRows = 0;
  let failedFiles = 0;

  try {
    for (const file of files) {
      try {
        const summary = await scanHistoryFile(file, sourceRoot);
        const existing = await getExistingFile(pool, batchId, summary.relativePath);
        const reusable = existing?.status === 'completed' && existing.checksum === summary.checksum
          ? existing
          : await getReusableCompletedFile(pool, summary.relativePath, summary.checksum);
        if (reusable) {
          if (existing?.status !== 'completed' || existing.checksum !== summary.checksum) {
            await markFileReused(pool, batchId, summary, Number(reusable.imported_rows));
            await refreshBatchCounters(pool, batchId);
          }
          completedFiles += 1;
          importedRows += Number(reusable.imported_rows);
          options.onProgress?.({
            batchId,
            completedFiles,
            totalFiles: files.length,
            importedRows,
            currentFile: summary.relativePath,
            status: 'skipped',
          });
          continue;
        }

        await markFileRunning(pool, batchId, summary);
        let imported: number;
        try {
          const instrument = await upsertInstrument(pool, summary);
          imported = summary.rows === 0
            ? 0
            : await loadHistoryFile(
              pool,
              summary,
              instrument.instrumentKey,
              batchId,
              chunkRows,
              options.cacheRoot,
              Math.max(100, options.fallbackBatchRows ?? 1_000),
              options.requireLocalInfile ?? false,
            );
          await recordQualityWarnings(pool, instrument.id, summary);
          await markFileCompleted(pool, batchId, summary, imported);
        } catch (error) {
          await markFileFailed(pool, batchId, summary, error);
          throw error;
        }
        completedFiles += 1;
        importedRows += imported;
        await refreshBatchCounters(pool, batchId);
        options.onProgress?.({
          batchId,
          completedFiles,
          totalFiles: files.length,
          importedRows,
          currentFile: summary.relativePath,
          status: 'importing',
        });
      } catch (error) {
        failedFiles += 1;
        await markPathFailed(pool, batchId, file, sourceRoot, error);
        await refreshBatchCounters(pool, batchId);
        options.onProgress?.({
          batchId,
          completedFiles,
          totalFiles: files.length,
          importedRows,
          currentFile: relative(sourceRoot, file).replaceAll('\\', '/'),
          status: 'failed',
        });
        console.error(
          `\n[history-import] 跳过失败文件 ${basename(file)}：`
          + `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    await pool.execute(
      `UPDATE data_import_batches
       SET status = ?, failed_files = ?, finished_at = NOW(3)
       WHERE id = ?`,
      [failedFiles > 0 ? 'partial' : 'completed', failedFiles, batchId],
    );
  } catch (error) {
    await pool.execute(
      `UPDATE data_import_batches
       SET status = 'failed', finished_at = NOW(3)
       WHERE id = ?`,
      [batchId],
    );
    throw error;
  }

  options.onProgress?.({
    batchId,
    completedFiles,
    totalFiles: files.length,
    importedRows,
    currentFile: '',
    status: 'completed',
  });
  return {
    batchId,
    files: files.length,
    completedFiles,
    importedRows,
    failedFiles,
    dryRun: false,
    importMode: fallbackUsed && localInfileUsed
      ? 'mixed'
      : fallbackUsed ? 'batched_replace' : 'local_infile',
  };
}

async function loadHistoryFile(
  pool: Pool,
  summary: CsvFileSummary,
  instrumentKey: number,
  batchId: string,
  chunkRows: number,
  cacheRoot: string,
  fallbackBatchRows: number,
  requireLocalInfile: boolean,
): Promise<number> {
  const cacheDir = resolve(cacheRoot, batchId);
  await mkdir(cacheDir, { recursive: true });
  const sourceVersion = summary.checksum.slice(0, 32);
  const fetchedAt = sqlDateTime(new Date());
  const input = createReadStream(summary.path, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let lineNumber = 0;
  let imported = 0;
  let chunkIndex = 0;
  let bars: string[] = [];
  let metrics: string[] = [];

  const flush = async () => {
    if (bars.length === 0) return;
    chunkIndex += 1;
    const prefix = `${summary.code}-${String(chunkIndex).padStart(5, '0')}`;
    const barsPath = join(cacheDir, `${prefix}-bars.tsv`);
    const metricsPath = join(cacheDir, `${prefix}-metrics.tsv`);
    await Promise.all([
      writeFile(barsPath, `${bars.join('\n')}\n`, 'utf8'),
      writeFile(metricsPath, `${metrics.join('\n')}\n`, 'utf8'),
    ]);
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      await loadTsv(connection, barsPath, 'daily_bars_v2', [
        'instrument_key', 'trade_date', 'open', 'high', 'low', 'close',
        'previous_close', 'volume', 'amount', 'turnover_rate_pct',
        'source_key', 'source_version', 'fetched_at',
      ], fallbackBatchRows, requireLocalInfile);
      await loadTsv(connection, metricsPath, 'daily_stock_metrics', [
        'instrument_key', 'trade_date', 'total_shares', 'float_shares',
        'total_market_cap', 'float_market_cap', 'pe_ttm', 'pb', 'ps_ttm',
        'volume_ratio', 'is_st', 'is_limit_up',
      ], fallbackBatchRows, requireLocalInfile);
      await connection.commit();
      imported += bars.length;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
      await Promise.all([
        unlink(barsPath).catch(() => undefined),
        unlink(metricsPath).catch(() => undefined),
      ]);
    }
    bars = [];
    metrics = [];
  };

  for await (const line of lines) {
    lineNumber += 1;
    if (lineNumber === 1 || !line.trim()) continue;
    const row = normalizeHistoryRecord(
      parseHistoryRecord(line),
      { allowInvalidOhlc: true },
    );
    bars.push([
      instrumentKey, row.tradeDate, row.open, row.high, row.low, row.close,
      row.previousClose, row.volume, row.amount, row.turnoverRatePct,
      1, sourceVersion, fetchedAt,
    ].map(toTsv).join('\t'));
    metrics.push([
      instrumentKey, row.tradeDate, row.totalShares, row.floatShares,
      row.totalMarketCap, row.floatMarketCap, row.peTtm, row.pb, row.psTtm,
      row.volumeRatio, row.isSt ? 1 : 0, row.isLimitUp ? 1 : 0,
    ].map(toTsv).join('\t'));
    if (bars.length >= chunkRows) await flush();
  }
  await flush();
  return imported;
}

async function loadTsv(
  connection: PoolConnection,
  filePath: string,
  table: 'daily_bars_v2' | 'daily_stock_metrics',
  columns: string[],
  fallbackBatchRows: number,
  requireLocalInfile: boolean,
): Promise<void> {
  const expected = resolve(filePath);
  if (!localInfileAvailable) {
    fallbackUsed = true;
    await loadTsvWithBatchedReplace(connection, expected, table, columns, fallbackBatchRows);
    return;
  }
  try {
    await connection.query({
      sql: `LOAD DATA LOCAL INFILE ${connection.escape(expected)}
        REPLACE INTO TABLE ${table}
        CHARACTER SET utf8mb4
        FIELDS TERMINATED BY '\\t'
        LINES TERMINATED BY '\\n'
        (${columns.map((column) => `\`${column}\``).join(', ')})`,
      infileStreamFactory: (requestedPath: string) => {
        if (resolve(requestedPath) !== expected) {
          throw new Error(`MySQL 请求了未授权的本地文件：${requestedPath}`);
        }
        return createReadStream(expected);
      },
    });
    localInfileUsed = true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('Loading local data is disabled')) throw error;
    if (requireLocalInfile) {
      throw new Error(`LOCAL INFILE 在执行阶段不可用，已拒绝降级：${message}`);
    }
    localInfileAvailable = false;
    fallbackUsed = true;
    console.warn('\n[history-import] MySQL LOCAL INFILE 未启用，降级为批量 REPLACE。');
    await loadTsvWithBatchedReplace(connection, expected, table, columns, fallbackBatchRows);
  }
}

async function loadTsvWithBatchedReplace(
  connection: PoolConnection,
  filePath: string,
  table: 'daily_bars_v2' | 'daily_stock_metrics',
  columns: string[],
  batchRows: number,
): Promise<void> {
  const input = createReadStream(filePath, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let batch: Array<Array<string | null>> = [];
  const flush = async () => {
    if (batch.length === 0) return;
    const rowPlaceholders = `(${columns.map(() => '?').join(',')})`;
    const placeholders = batch.map(() => rowPlaceholders).join(',');
    await connection.query(
      `REPLACE INTO ${table}
       (${columns.map((column) => `\`${column}\``).join(',')})
       VALUES ${placeholders}`,
      batch.flat(),
    );
    batch = [];
  };
  for await (const line of lines) {
    if (!line) continue;
    batch.push(line.split('\t').map((value) => value === '\\N' ? null : value));
    if (batch.length >= batchRows) await flush();
  }
  await flush();
}

async function detectLocalInfile(pool: Pool): Promise<boolean> {
  const [rows] = await pool.query<RowDataPacket[]>('SELECT @@GLOBAL.local_infile AS enabled');
  const value = rows[0]?.enabled;
  return value === 1 || value === '1' || String(value).toUpperCase() === 'ON';
}

async function upsertInstrument(
  pool: Pool,
  summary: CsvFileSummary,
): Promise<{ id: string; instrumentKey: number }> {
  const row = summary.latestRow;
  const name = row?.name ?? summary.code;
  const status = row
    ? inferInstrumentStatus(row.name, row.delistDate)
    : 'delisted';
  await pool.execute(
    `INSERT INTO instruments (
       id, market, symbol, name, industry, type, list_date, delist_date,
       status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 'stock', ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       name = VALUES(name),
       industry = VALUES(industry),
       list_date = COALESCE(VALUES(list_date), list_date),
       delist_date = COALESCE(VALUES(delist_date), delist_date),
       status = VALUES(status),
       updated_at = VALUES(updated_at)`,
    [
      randomUUID(), inferMarket(summary.code), summary.code, name,
      row?.industry ?? null, row?.listDate ?? null, row?.delistDate ?? null,
      status, new Date().toISOString(), new Date().toISOString(),
    ],
  );
  const [rows] = await pool.execute<InstrumentKeyRow[]>(
    `SELECT id, instrument_key
     FROM instruments
     WHERE market = ? AND symbol = ? AND type = 'stock'
     LIMIT 1`,
    [inferMarket(summary.code), summary.code],
  );
  if (!rows[0]?.instrument_key) throw new Error(`无法获得 ${summary.code} 的 instrument_key`);
  return { id: rows[0].id, instrumentKey: Number(rows[0].instrument_key) };
}

async function upsertBatch(
  pool: Pool,
  batchId: string,
  sourceRoot: string,
  snapshot: string,
  totalFiles: number,
): Promise<void> {
  const [existing] = await pool.execute<ExistingBatchRow[]>(
    'SELECT source_snapshot FROM data_import_batches WHERE id = ? LIMIT 1',
    [batchId],
  );
  if (existing[0] && existing[0].source_snapshot !== snapshot) {
    throw new Error('源文件快照已变化，不能复用原批次 ID；请创建新批次');
  }
  await pool.execute(
    `INSERT INTO data_import_batches (
       id, source_root, source_snapshot, status, total_files, started_at
     ) VALUES (?, ?, ?, 'running', ?, NOW(3))
     ON DUPLICATE KEY UPDATE
       status = 'running',
       total_files = VALUES(total_files),
       finished_at = NULL`,
    [batchId, sourceRoot, snapshot, totalFiles],
  );
}

async function recoverFailedImportFiles(pool: Pool): Promise<void> {
  await pool.execute(
    `UPDATE data_import_files AS file
     INNER JOIN data_import_batches AS batch ON batch.id = file.batch_id
     SET file.status = 'failed',
         file.error_message = COALESCE(file.error_message, '父批次失败'),
         file.finished_at = COALESCE(file.finished_at, NOW(3))
     WHERE file.status = 'running' AND batch.status = 'failed'`,
  );
}

async function getExistingFile(
  pool: Pool,
  batchId: string,
  relativePath: string,
): Promise<ExistingFileRow | null> {
  const [rows] = await pool.execute<ExistingFileRow[]>(
    `SELECT status, checksum, imported_rows
     FROM data_import_files
     WHERE batch_id = ? AND relative_path = ?
     LIMIT 1`,
    [batchId, relativePath],
  );
  return rows[0] ?? null;
}

async function getReusableCompletedFile(
  pool: Pool,
  relativePath: string,
  checksum: string,
): Promise<ExistingFileRow | null> {
  const [rows] = await pool.execute<ExistingFileRow[]>(
    `SELECT status, checksum, imported_rows
     FROM data_import_files
     WHERE relative_path = ?
       AND checksum = ?
       AND status = 'completed'
     ORDER BY finished_at DESC
     LIMIT 1`,
    [relativePath, checksum],
  );
  return rows[0] ?? null;
}

async function markFileRunning(
  pool: Pool,
  batchId: string,
  summary: CsvFileSummary,
): Promise<void> {
  await pool.execute(
    `INSERT INTO data_import_files (
       batch_id, relative_path, adjustment_mode, checksum, expected_rows,
       imported_rows, min_date, max_date, status, started_at
     ) VALUES (?, ?, 'none', ?, ?, 0, ?, ?, 'running', NOW(3))
     ON DUPLICATE KEY UPDATE
       checksum = VALUES(checksum),
       expected_rows = VALUES(expected_rows),
       imported_rows = 0,
       min_date = VALUES(min_date),
       max_date = VALUES(max_date),
       status = 'running',
       error_message = NULL,
       started_at = NOW(3),
       finished_at = NULL`,
    [
      batchId, summary.relativePath, summary.checksum, summary.rows,
      summary.minDate, summary.maxDate,
    ],
  );
}

async function markFileCompleted(
  pool: Pool,
  batchId: string,
  summary: CsvFileSummary,
  importedRows: number,
): Promise<void> {
  await pool.execute(
    `UPDATE data_import_files
     SET status = 'completed', imported_rows = ?, error_message = ?, finished_at = NOW(3)
     WHERE batch_id = ? AND relative_path = ?`,
    [
      importedRows,
      summary.warnings.length > 0 ? `保留 ${summary.warnings.length} 条阻断级质量异常` : null,
      batchId,
      summary.relativePath,
    ],
  );
}

async function recordQualityWarnings(
  pool: Pool,
  instrumentId: string,
  summary: CsvFileSummary,
): Promise<void> {
  for (const warning of summary.warnings) {
    await pool.execute(
      `DELETE FROM data_quality_issues
       WHERE instrument_id = ? AND trade_date = ? AND rule_code = 'INVALID_OHLC'`,
      [instrumentId, warning.tradeDate],
    );
    await pool.execute(
      `INSERT INTO data_quality_issues (
         id, instrument_id, trade_date, rule_code, severity, status,
         details, detected_at
       ) VALUES (?, ?, ?, 'INVALID_OHLC', 'blocked', 'open', ?, ?)`,
      [
        randomUUID(),
        instrumentId,
        warning.tradeDate,
        JSON.stringify({
          sourceFile: summary.relativePath,
          lineNumber: warning.lineNumber,
          message: warning.message,
        }),
        new Date().toISOString(),
      ],
    );
  }
}

async function markFileReused(
  pool: Pool,
  batchId: string,
  summary: CsvFileSummary,
  importedRows: number,
): Promise<void> {
  await pool.execute(
    `INSERT INTO data_import_files (
       batch_id, relative_path, adjustment_mode, checksum, expected_rows,
       imported_rows, min_date, max_date, status, error_message,
       started_at, finished_at
     ) VALUES (?, ?, 'none', ?, ?, ?, ?, ?, 'completed',
               '复用既有已验证文件', NOW(3), NOW(3))
     ON DUPLICATE KEY UPDATE
       checksum = VALUES(checksum),
       expected_rows = VALUES(expected_rows),
       imported_rows = VALUES(imported_rows),
       min_date = VALUES(min_date),
       max_date = VALUES(max_date),
       status = 'completed',
       error_message = VALUES(error_message),
       finished_at = NOW(3)`,
    [
      batchId, summary.relativePath, summary.checksum, summary.rows,
      importedRows, summary.minDate, summary.maxDate,
    ],
  );
}

async function markFileFailed(
  pool: Pool,
  batchId: string,
  summary: CsvFileSummary,
  error: unknown,
): Promise<void> {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
  await pool.execute(
    `UPDATE data_import_files
     SET status = 'failed', error_message = ?, finished_at = NOW(3)
     WHERE batch_id = ? AND relative_path = ?`,
    [message, batchId, summary.relativePath],
  );
}

async function markPathFailed(
  pool: Pool,
  batchId: string,
  filePath: string,
  sourceRoot: string,
  error: unknown,
): Promise<void> {
  const relativePath = relative(sourceRoot, filePath).replaceAll('\\', '/');
  const checksum = await sha256File(filePath);
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
  await pool.execute(
    `INSERT INTO data_import_files (
       batch_id, relative_path, adjustment_mode, checksum,
       expected_rows, imported_rows, status, error_message,
       started_at, finished_at
     ) VALUES (?, ?, 'none', ?, 0, 0, 'failed', ?, NOW(3), NOW(3))
     ON DUPLICATE KEY UPDATE
       checksum = VALUES(checksum),
       status = 'failed',
       error_message = VALUES(error_message),
       finished_at = NOW(3)`,
    [batchId, relativePath, checksum, message],
  );
}

async function refreshBatchCounters(pool: Pool, batchId: string): Promise<void> {
  await pool.execute(
    `UPDATE data_import_batches
     SET completed_files = (
       SELECT COUNT(*) FROM data_import_files
       WHERE batch_id = ? AND status = 'completed'
     ),
     total_rows = (
       SELECT COALESCE(SUM(expected_rows), 0) FROM data_import_files
       WHERE batch_id = ?
     ),
     imported_rows = (
       SELECT COALESCE(SUM(imported_rows), 0) FROM data_import_files
       WHERE batch_id = ?
     )
     WHERE id = ?`,
    [batchId, batchId, batchId, batchId],
  );
}

async function buildSourceSnapshot(files: string[], sourceRoot: string): Promise<string> {
  const hash = createHash('sha256');
  for (const file of files) {
    const info = await stat(file);
    hash.update(relative(sourceRoot, file).replaceAll('\\', '/'));
    hash.update(`\0${info.size}\0${info.mtimeMs}\n`);
  }
  return hash.digest('hex');
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

function toTsv(value: string | number | null): string {
  return value === null ? '\\N' : String(value);
}

function sqlDateTime(value: Date): string {
  return value.toISOString().replace('T', ' ').replace('Z', '');
}
