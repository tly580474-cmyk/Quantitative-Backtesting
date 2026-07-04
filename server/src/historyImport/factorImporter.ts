import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type {
  Pool,
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from 'mysql2/promise';
import { assertHistoryHeader, inferMarket, parseHistoryRecord } from './csv.js';
import {
  deriveCompressedFactors,
  validateHfqCrosscheck,
  type CompressedFactor,
  type PriceRow,
  type ReconstructionStats,
} from './factor.js';

export interface FactorImportOptions {
  sourceRoot: string;
  batchId?: string;
  codes?: string[];
  limit?: number;
  reportRoot: string;
  onProgress?: (progress: FactorImportProgress) => void;
}

export interface FactorImportProgress {
  batchId: string;
  factorVersion: string;
  completedFiles: number;
  totalFiles: number;
  storedFactors: number;
  currentFile: string;
  status: 'computing' | 'skipped' | 'failed' | 'completed';
}

export interface FactorFileReport {
  code: string;
  status: 'completed' | 'skipped' | 'failed';
  factors: number;
  qfqRows: number;
  hfqRows: number;
  overlapRows: number;
  overrideRows: number;
  missingRawRows: number;
  latestAnchorMismatch: boolean;
  qfqStats?: ReconstructionStats;
  hfqStats?: ReconstructionStats;
  error?: string;
}

interface InstrumentRow extends RowDataPacket {
  id: string;
  instrument_key: number;
}

interface RawPriceRow extends RowDataPacket, PriceRow {}

interface ExistingFileRow extends RowDataPacket {
  status: string;
  checksum: string;
  imported_rows: number;
}

interface ExistingBatchRow extends RowDataPacket {
  source_snapshot: string;
}

interface AdjustedFile {
  path: string;
  relativePath: string;
  checksum: string;
  rows: PriceRow[];
  minDate: string | null;
  maxDate: string | null;
}

const QFQ_DIRECTORY = '前复权';
const HFQ_DIRECTORY = '后复权';
const SOURCE_KEY = 1;
const QUALITY_RATIO = 0.995;

export async function importAdjustmentFactors(
  pool: Pool,
  options: FactorImportOptions,
): Promise<{
  batchId: string;
  factorVersion: string;
  files: number;
  completedFiles: number;
  failedFiles: number;
  storedFactors: number;
  storedOverrides: number;
  reportPath: string;
}> {
  const sourceRoot = resolve(options.sourceRoot);
  const files = await discoverQfqFiles(sourceRoot, options.codes, options.limit);
  if (files.length === 0) throw new Error('没有找到待处理的前复权 CSV');
  const snapshot = await buildFactorSourceSnapshot(files, sourceRoot);
  const factorVersion = `m2-${snapshot.slice(0, 20)}`;
  const batchId = options.batchId ?? randomUUID();
  await upsertBatch(pool, batchId, sourceRoot, snapshot, files.length);

  let completedFiles = 0;
  let failedFiles = 0;
  let storedFactors = 0;
  let storedOverrides = 0;
  const reports: FactorFileReport[] = [];

  for (const qfqPath of files) {
    const code = basename(qfqPath, '.csv');
    const relativePath = relative(sourceRoot, qfqPath).replaceAll('\\', '/');
    try {
      const hfqPath = join(sourceRoot, HFQ_DIRECTORY, `${code}.csv`);
      const qfqPromise = readAdjustedFile(qfqPath, sourceRoot);
      const hfqPromise = stat(hfqPath)
        .then(() => readAdjustedFile(hfqPath, sourceRoot))
        .catch(() => null);
      const [qfq, hfq] = await Promise.all([qfqPromise, hfqPromise]);
      const checksum = combinedChecksum(qfq.checksum, hfq?.checksum);
      const existing = await getExistingFile(pool, batchId, relativePath);
      if (existing?.status === 'completed' && existing.checksum === checksum) {
        completedFiles += 1;
        storedFactors += Number(existing.imported_rows);
        reports.push({
          code,
          status: 'skipped',
          factors: Number(existing.imported_rows),
          qfqRows: qfq.rows.length,
          hfqRows: hfq?.rows.length ?? 0,
          overlapRows: 0,
          overrideRows: 0,
          missingRawRows: 0,
          latestAnchorMismatch: false,
        });
        options.onProgress?.({
          batchId,
          factorVersion,
          completedFiles,
          totalFiles: files.length,
          storedFactors,
          currentFile: relativePath,
          status: 'skipped',
        });
        continue;
      }

      await markFileRunning(pool, batchId, qfq, checksum);
      const instrument = await getInstrument(pool, code);
      if (qfq.rows.length === 0) {
        const connection = await pool.getConnection();
        try {
          await connection.beginTransaction();
          await replaceFactors(
            connection,
            instrument.instrument_key,
            factorVersion,
            batchId,
            [],
          );
          await replaceOverrides(connection, instrument.instrument_key, batchId, []);
          await connection.commit();
        } catch (error) {
          await connection.rollback();
          throw error;
        } finally {
          connection.release();
        }
        await markFileCompleted(pool, batchId, relativePath, 0, '空文件，无需计算复权因子');
        completedFiles += 1;
        reports.push({
          code,
          status: 'completed',
          factors: 0,
          qfqRows: 0,
          hfqRows: hfq?.rows.length ?? 0,
          overlapRows: 0,
          overrideRows: 0,
          missingRawRows: 0,
          latestAnchorMismatch: false,
        });
        await refreshBatchCounters(pool, batchId);
        options.onProgress?.({
          batchId,
          factorVersion,
          completedFiles,
          totalFiles: files.length,
          storedFactors,
          currentFile: relativePath,
          status: 'computing',
        });
        continue;
      }
      const rawRows = await getRawPrices(pool, instrument.instrument_key);
      const derived = deriveCompressedFactors(rawRows, qfq.rows);
      if (derived.factors.length === 0) {
        throw new Error('前复权与不复权数据没有重叠日期，无法推导因子');
      }
      const hfqStats = hfq
        ? validateHfqCrosscheck(rawRows, qfq.rows, hfq.rows, derived.factors)
        : undefined;

      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        await replaceFactors(
          connection,
          instrument.instrument_key,
          factorVersion,
          batchId,
          derived.factors,
        );
        await replaceOverrides(
          connection,
          instrument.instrument_key,
          batchId,
          derived.qfqOnlyEarlyRows,
        );
        await replaceQualityIssues(connection, instrument.id, {
          code,
          sourceFile: qfq.relativePath,
          factorVersion,
          qfqStats: derived.qfqStats,
          hfqStats,
          latestAnchorMismatch: derived.latestAnchorMismatch,
          missingRawRows: derived.missingRawRows,
        });
        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }

      const summaryMessage = buildSummaryMessage(
        derived.qfqStats,
        hfqStats,
        derived.latestAnchorMismatch,
        derived.missingRawRows,
      );
      await markFileCompleted(
        pool,
        batchId,
        relativePath,
        derived.factors.length,
        summaryMessage,
      );
      completedFiles += 1;
      storedFactors += derived.factors.length;
      storedOverrides += derived.qfqOnlyEarlyRows.length;
      reports.push({
        code,
        status: 'completed',
        factors: derived.factors.length,
        qfqRows: qfq.rows.length,
        hfqRows: hfq?.rows.length ?? 0,
        overlapRows: derived.overlapRows,
        overrideRows: derived.qfqOnlyEarlyRows.length,
        missingRawRows: derived.missingRawRows,
        latestAnchorMismatch: derived.latestAnchorMismatch,
        qfqStats: derived.qfqStats,
        hfqStats,
      });
      await refreshBatchCounters(pool, batchId);
      options.onProgress?.({
        batchId,
        factorVersion,
        completedFiles,
        totalFiles: files.length,
        storedFactors,
        currentFile: relativePath,
        status: 'computing',
      });
    } catch (error) {
      failedFiles += 1;
      const message = error instanceof Error ? error.message : String(error);
      await markFileFailed(pool, batchId, relativePath, message);
      await refreshBatchCounters(pool, batchId);
      reports.push({
        code,
        status: 'failed',
        factors: 0,
        qfqRows: 0,
        hfqRows: 0,
        overlapRows: 0,
        overrideRows: 0,
        missingRawRows: 0,
        latestAnchorMismatch: false,
        error: message,
      });
      options.onProgress?.({
        batchId,
        factorVersion,
        completedFiles,
        totalFiles: files.length,
        storedFactors,
        currentFile: relativePath,
        status: 'failed',
      });
    }
  }

  await pool.execute(
    `UPDATE data_import_batches
     SET status = ?, failed_files = ?, finished_at = NOW(3)
     WHERE id = ?`,
    [failedFiles > 0 ? 'partial' : 'completed', failedFiles, batchId],
  );
  await mkdir(resolve(options.reportRoot), { recursive: true });
  const reportPath = resolve(options.reportRoot, `factor-report-${batchId}.json`);
  await writeFile(reportPath, JSON.stringify({
    batchId,
    factorVersion,
    sourceRoot,
    sourceSnapshot: snapshot,
    generatedAt: new Date().toISOString(),
    totals: {
      files: files.length,
      completedFiles,
      failedFiles,
      storedFactors,
      storedOverrides,
    },
    files: reports,
  }, null, 2), 'utf8');
  options.onProgress?.({
    batchId,
    factorVersion,
    completedFiles,
    totalFiles: files.length,
    storedFactors,
    currentFile: '',
    status: 'completed',
  });
  return {
    batchId,
    factorVersion,
    files: files.length,
    completedFiles,
    failedFiles,
    storedFactors,
    storedOverrides,
    reportPath,
  };
}

async function discoverQfqFiles(
  sourceRoot: string,
  codes?: string[],
  limit?: number,
): Promise<string[]> {
  const directory = join(sourceRoot, QFQ_DIRECTORY);
  const requested = codes?.length
    ? new Set(codes.map((code) => code.padStart(6, '0')))
    : null;
  const names = (await readdir(directory))
    .filter((name) => /^\d{6}\.csv$/.test(name))
    .filter((name) => !requested || requested.has(name.slice(0, 6)))
    .sort();
  return names
    .slice(0, limit && limit > 0 ? limit : undefined)
    .map((name) => join(directory, name));
}

async function readAdjustedFile(filePath: string, sourceRoot: string): Promise<AdjustedFile> {
  const hash = createHash('sha256');
  const input = createReadStream(filePath, { encoding: 'utf8' });
  input.on('data', (chunk) => hash.update(chunk));
  const lines = createInterface({ input, crlfDelay: Infinity });
  const rows: PriceRow[] = [];
  let lineNumber = 0;
  let previousDate: string | null = null;
  for await (const line of lines) {
    lineNumber += 1;
    if (lineNumber === 1) {
      assertHistoryHeader(line);
      continue;
    }
    if (!line.trim()) continue;
    const record = parseHistoryRecord(line);
    const tradeDate = normalizeDate(record['日期']);
    if (previousDate !== null && tradeDate <= previousDate) {
      throw new Error(`${basename(filePath)} 日期重复或未严格升序：${previousDate} → ${tradeDate}`);
    }
    rows.push({
      tradeDate,
      open: finitePrice(record['开盘价'], tradeDate, '开盘价'),
      high: finitePrice(record['最高价'], tradeDate, '最高价'),
      low: finitePrice(record['最低价'], tradeDate, '最低价'),
      close: finitePrice(record['收盘价'], tradeDate, '收盘价'),
    });
    previousDate = tradeDate;
  }
  if (lineNumber === 0) throw new Error(`${basename(filePath)} 是空文件`);
  return {
    path: resolve(filePath),
    relativePath: relative(sourceRoot, filePath).replaceAll('\\', '/'),
    checksum: hash.digest('hex'),
    rows,
    minDate: rows[0]?.tradeDate ?? null,
    maxDate: rows[rows.length - 1]?.tradeDate ?? null,
  };
}

async function getInstrument(pool: Pool, code: string): Promise<InstrumentRow> {
  const [rows] = await pool.execute<InstrumentRow[]>(
    `SELECT id, instrument_key
     FROM instruments
     WHERE market = ? AND symbol = ? AND type = 'stock'
     LIMIT 1`,
    [inferMarket(code), code],
  );
  if (!rows[0]) throw new Error(`数据库缺少证券 ${code}`);
  return rows[0];
}

async function getRawPrices(pool: Pool, instrumentKey: number): Promise<PriceRow[]> {
  const [rows] = await pool.execute<RawPriceRow[]>(
    `SELECT
       DATE_FORMAT(trade_date, '%Y-%m-%d') AS tradeDate,
       open, high, low, close
     FROM daily_bars_v2
     WHERE instrument_key = ?
     ORDER BY trade_date`,
    [instrumentKey],
  );
  return rows.map((row) => ({
    tradeDate: row.tradeDate,
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
  }));
}

async function replaceFactors(
  connection: PoolConnection,
  instrumentKey: number,
  factorVersion: string,
  batchId: string,
  factors: CompressedFactor[],
): Promise<void> {
  await connection.execute(
    'DELETE FROM adjustment_factors_v2 WHERE instrument_key = ? AND factor_version = ?',
    [instrumentKey, factorVersion],
  );
  for (let offset = 0; offset < factors.length; offset += 500) {
    const chunk = factors.slice(offset, offset + 500);
    const placeholders = chunk.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(',');
    await connection.query(
      `INSERT INTO adjustment_factors_v2 (
         instrument_key, effective_date, factor_version, factor, price_offset,
         source_key, source_batch_id
       ) VALUES ${placeholders}`,
      chunk.flatMap((item) => [
        instrumentKey,
        item.effectiveDate,
        factorVersion,
        item.factor,
        item.offset,
        SOURCE_KEY,
        batchId,
      ]),
    );
  }
}

async function replaceOverrides(
  connection: PoolConnection,
  instrumentKey: number,
  batchId: string,
  rows: PriceRow[],
): Promise<void> {
  await connection.execute(
    `DELETE FROM adjusted_bar_overrides
     WHERE instrument_key = ? AND adjustment_mode = 'qfq'`,
    [instrumentKey],
  );
  for (let offset = 0; offset < rows.length; offset += 500) {
    const chunk = rows.slice(offset, offset + 500);
    const placeholders = chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?)').join(',');
    await connection.query(
      `INSERT INTO adjusted_bar_overrides (
         instrument_key, trade_date, adjustment_mode,
         open, high, low, close, reason, source_batch_id
       ) VALUES ${placeholders}`,
      chunk.flatMap((row) => [
        instrumentKey,
        row.tradeDate,
        'qfq',
        row.open,
        row.high,
        row.low,
        row.close,
        'qfq_only_early_history',
        batchId,
      ]),
    );
  }
}

async function replaceQualityIssues(
  connection: PoolConnection,
  instrumentId: string,
  input: {
    code: string;
    sourceFile: string;
    factorVersion: string;
    qfqStats: ReconstructionStats;
    hfqStats?: ReconstructionStats;
    latestAnchorMismatch: boolean;
    missingRawRows: number;
  },
): Promise<void> {
  const rules = ['ADJUSTMENT_QFQ_RECONSTRUCTION', 'ADJUSTMENT_HFQ_CROSSCHECK'];
  await connection.query(
    `DELETE FROM data_quality_issues
     WHERE instrument_id = ? AND rule_code IN (?, ?)`,
    [instrumentId, ...rules],
  );
  const qfqWarning = input.latestAnchorMismatch
    || input.missingRawRows > 0
    || input.qfqStats.withinTickRatio < QUALITY_RATIO;
  if (qfqWarning) {
    await insertQualityIssue(
      connection,
      instrumentId,
      input.qfqStats.firstMismatchDate ?? '1900-01-01',
      rules[0],
      {
        code: input.code,
        sourceFile: input.sourceFile,
        factorVersion: input.factorVersion,
        latestAnchorMismatch: input.latestAnchorMismatch,
        missingRawRows: input.missingRawRows,
        stats: input.qfqStats,
      },
    );
  }
  if (input.hfqStats && input.hfqStats.withinTickRatio < QUALITY_RATIO) {
    await insertQualityIssue(
      connection,
      instrumentId,
      input.hfqStats.firstMismatchDate ?? '1900-01-01',
      rules[1],
      {
        code: input.code,
        factorVersion: input.factorVersion,
        stats: input.hfqStats,
      },
    );
  }
}

async function insertQualityIssue(
  connection: PoolConnection,
  instrumentId: string,
  tradeDate: string,
  ruleCode: string,
  details: object,
): Promise<void> {
  await connection.execute<ResultSetHeader>(
    `INSERT INTO data_quality_issues (
       id, instrument_id, trade_date, rule_code, severity, status, details, detected_at
     ) VALUES (?, ?, ?, ?, 'warning', 'open', ?, ?)`,
    [
      randomUUID(),
      instrumentId,
      tradeDate,
      ruleCode,
      JSON.stringify(details),
      new Date().toISOString(),
    ],
  );
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
    throw new Error('源文件快照已变化，不能复用原批次 ID');
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

async function markFileRunning(
  pool: Pool,
  batchId: string,
  file: AdjustedFile,
  checksum: string,
): Promise<void> {
  await pool.execute(
    `INSERT INTO data_import_files (
       batch_id, relative_path, adjustment_mode, checksum, expected_rows,
       imported_rows, min_date, max_date, status, started_at
     ) VALUES (?, ?, 'qfq', ?, ?, 0, ?, ?, 'running', NOW(3))
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
      batchId,
      file.relativePath,
      checksum,
      file.rows.length,
      file.minDate,
      file.maxDate,
    ],
  );
}

async function markFileCompleted(
  pool: Pool,
  batchId: string,
  relativePath: string,
  factors: number,
  message: string | null,
): Promise<void> {
  await pool.execute(
    `UPDATE data_import_files
     SET status = 'completed', imported_rows = ?, error_message = ?, finished_at = NOW(3)
     WHERE batch_id = ? AND relative_path = ?`,
    [factors, message, batchId, relativePath],
  );
}

async function markFileFailed(
  pool: Pool,
  batchId: string,
  relativePath: string,
  message: string,
): Promise<void> {
  await pool.execute(
    `UPDATE data_import_files
     SET status = 'failed', error_message = ?, finished_at = NOW(3)
     WHERE batch_id = ? AND relative_path = ?`,
    [message.slice(0, 1000), batchId, relativePath],
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

async function buildFactorSourceSnapshot(files: string[], sourceRoot: string): Promise<string> {
  const hash = createHash('sha256');
  for (const qfqPath of files) {
    const code = basename(qfqPath);
    for (const filePath of [qfqPath, join(sourceRoot, HFQ_DIRECTORY, code)]) {
      try {
        const info = await stat(filePath);
        hash.update(relative(sourceRoot, filePath).replaceAll('\\', '/'));
        hash.update(`\0${info.size}\0${info.mtimeMs}\n`);
      } catch {
        hash.update(`${relative(sourceRoot, filePath).replaceAll('\\', '/')}\0missing\n`);
      }
    }
  }
  return hash.digest('hex');
}

function combinedChecksum(qfq: string, hfq?: string): string {
  return createHash('sha256').update(qfq).update('\0').update(hfq ?? 'missing').digest('hex');
}

function buildSummaryMessage(
  qfq: ReconstructionStats,
  hfq: ReconstructionStats | undefined,
  latestAnchorMismatch: boolean,
  missingRawRows: number,
): string | null {
  const warnings: string[] = [];
  if (latestAnchorMismatch) warnings.push('前复权末日无法锚定 1');
  if (missingRawRows > 0) warnings.push(`${missingRawRows} 条非早期记录缺少不复权基准`);
  if (qfq.withinTickRatio < QUALITY_RATIO) {
    warnings.push(`前复权重建通过率 ${(qfq.withinTickRatio * 100).toFixed(2)}%`);
  }
  if (hfq && hfq.withinTickRatio < QUALITY_RATIO) {
    warnings.push(`后复权交叉验证通过率 ${(hfq.withinTickRatio * 100).toFixed(2)}%`);
  }
  return warnings.length > 0 ? warnings.join('；').slice(0, 1000) : null;
}

function finitePrice(value: string, tradeDate: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${tradeDate} ${label}无效：${value}`);
  }
  return parsed;
}

function normalizeDate(value: string): string {
  const compact = value.trim();
  if (/^\d{8}$/.test(compact)) {
    return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(compact)) {
    throw new Error(`日期格式无效：${value}`);
  }
  return compact;
}
