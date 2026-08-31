import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import type { SyncJob } from '../marketData/types.js';
import { listSyncJobs } from '../marketData/repositories/syncJobRepository.js';
import {
  latestCollectorRuns,
  type CollectorRun,
} from '../marketData/repositories/collectorRunRepository.js';

export type DataUpdateStatus = 'idle' | 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface DataUpdateProgressItem {
  key: 'fund_flow' | 'instrument_master' | 'minute_lake' | 'daily_kline' | 'financial_reports';
  label: string;
  status: DataUpdateStatus;
  phase: string;
  completed: number;
  total: number;
  failed: number;
  percent: number | null;
  startedAt: string | null;
  updatedAt: string | null;
  finishedAt: string | null;
  message: string | null;
  currentDate?: string | null;
  processedRows?: number | null;
  etaAt?: string | null;
}

interface MinuteProgressFile {
  status?: DataUpdateStatus;
  phase?: string;
  completed?: number;
  total?: number;
  failed?: number;
  startedAt?: string;
  updatedAt?: string;
  finishedAt?: string;
  message?: string;
}

interface FundFlowProgressFile {
  status?: DataUpdateStatus | 'completed_with_errors';
  phase?: string;
  completed?: number;
  total?: number;
  failed?: number;
  startedAt?: string;
  updatedAt?: string;
  finishedAt?: string;
  message?: string;
  inserted?: number;
  currentDate?: string;
  coverage?: number;
}

const MINUTE_STALE_MS = 15 * 60_000;
const FUND_FLOW_STALE_MS = 5 * 60_000;
const DEFAULT_MINUTE_ROOT = '../../所有股票的历史数据/1m_price_parquet';

export interface MinuteSnapshot {
  /** 分钟湖快照（manifest）实际覆盖的最新日期 */
  lastDate: string | null;
  /** MySQL 权威日线日期（daily_candles 最大 trade_date） */
  authoritativeDate: string | null;
}

export interface MinuteProgressContext {
  pool: Pool | null;
  minuteRoot: string;
}

export async function collectDataUpdateProgress(
  dbOnline: boolean,
  serverRoot = resolve(process.cwd().replace(/[\\/]server$/, ''), 'server'),
  now = new Date(),
  minute: MinuteProgressContext = { pool: null, minuteRoot: DEFAULT_MINUTE_ROOT },
): Promise<{ generatedAt: string; items: DataUpdateProgressItem[] }> {
  const [fundFlow, instrument, minuteItem, daily, financial] = await Promise.all([
    readFundFlowProgress(resolve(serverRoot, '.logs', 'fund-flow', 'progress.json'), now)
      .catch((error) => failedFundFlowProgress(error)),
    dbOnline ? readInstrumentProgress().catch((error) => failedInstrumentProgress(error)) : Promise.resolve(idleInstrumentProgress('数据库未连接')),
    readMinuteProgress(resolve(serverRoot, '.logs', 'minute-data', 'progress.json'), now, minute)
      .catch((error) => failedMinuteProgress(error)),
    dbOnline ? readDailyProgress().catch((error) => failedDailyProgress(error)) : Promise.resolve(idleDailyProgress('数据库未连接')),
    dbOnline ? readFinancialProgress().catch((error) => failedFinancialProgress(error)) : Promise.resolve(idleFinancialProgress('数据库未连接')),
  ]);
  return { generatedAt: now.toISOString(), items: [fundFlow, instrument, minuteItem, daily, financial] };
}

export function normalizeFundFlowProgress(
  value: FundFlowProgressFile | null,
  now = new Date(),
  startedAt: string | null = null,
): DataUpdateProgressItem {
  if (!value) return idleFundFlowProgress();
  const completed = positiveInteger(value.completed);
  const total = positiveInteger(value.total);
  const failed = positiveInteger(value.failed);
  const processedRows = positiveInteger(value.inserted);
  const updatedAt = validTimestamp(value.updatedAt);
  let status: DataUpdateStatus = value.status === 'completed_with_errors'
    ? 'completed'
    : normalizeStatus(value.status);
  let message = value.message?.trim() || null;
  if ((status === 'running' || status === 'pending') && isOlderThan(value.updatedAt, now, FUND_FLOW_STALE_MS)) {
    status = 'failed';
    message = '资金流进度超过 5 分钟未更新，回补进程可能已中断';
  }
  const percent = total > 0
    ? clampPercent((completed + failed) / total * 100)
    : status === 'completed' ? 100 : null;
  const etaAt = status === 'running' && value.phase === 'tinyshare-backfill'
    ? estimateCompletionTime(startedAt, now, completed, total)
    : null;
  const details = [
    value.currentDate ? `当前回补至 ${value.currentDate}` : null,
    processedRows > 0 ? `已写入 ${processedRows.toLocaleString('zh-CN')} 行` : null,
    failed > 0 ? `${failed} 个交易日待重试` : null,
  ].filter(Boolean).join(' · ');
  return {
    key: 'fund_flow',
    label: '个股资金流',
    status,
    phase: value.phase?.trim() || (status === 'running' ? 'tinyshare-backfill' : status),
    completed,
    total,
    failed,
    percent,
    startedAt: validTimestamp(startedAt),
    updatedAt,
    finishedAt: validTimestamp(value.finishedAt),
    message: message ?? (details || null),
    currentDate: value.currentDate?.trim() || null,
    processedRows,
    etaAt,
  };
}

export function normalizeInstrumentProgress(job: SyncJob | null): DataUpdateProgressItem {
  if (!job) return idleInstrumentProgress();
  const completed = positiveInteger(job.completedItems);
  const failed = positiveInteger(job.failedItems);
  const total = positiveInteger(job.totalItems);
  return {
    key: 'instrument_master',
    label: '证券主表',
    status: normalizeStatus(job.status),
    phase: job.status === 'pending'
      ? '排队准备'
      : job.status === 'running' ? '发现并同步全市场证券' : job.status,
    completed,
    total,
    failed,
    percent: total > 0
      ? clampPercent((completed + failed) / total * 100)
      : job.status === 'completed' ? 100 : null,
    startedAt: validTimestamp(job.startedAt),
    updatedAt: validTimestamp(job.finishedAt ?? job.startedAt ?? job.createdAt),
    finishedAt: validTimestamp(job.finishedAt),
    message: failed > 0
      ? `${failed} 只证券同步失败`
      : job.status === 'completed' ? `来源 ${job.providerId}，已核对 ${completed} 只证券` : null,
  };
}

export function normalizeMinuteProgress(
  value: MinuteProgressFile | null,
  now = new Date(),
  snapshot: MinuteSnapshot | null = null,
): DataUpdateProgressItem {
  const base = value ? {
    completed: positiveInteger(value.completed),
    total: positiveInteger(value.total),
    failed: positiveInteger(value.failed),
  } : { completed: 0, total: 0, failed: 0 };
  // 快照已覆盖权威日期 → 数据就绪，优先于在线更新心跳状态
  // （在线更新失败后通过 TDX 等渠道补全时，进度文件可能仍停留在失败/中断状态）
  const snapshotCurrent = snapshot?.authoritativeDate != null
    && snapshot.lastDate != null
    && snapshot.lastDate >= snapshot.authoritativeDate;
  if (snapshotCurrent) {
    const updatedAt = value ? validTimestamp(value.updatedAt) : null;
    return {
      key: 'minute_lake',
      label: '分钟湖数据',
      status: 'completed',
      phase: '快照已覆盖',
      completed: base.total > 0 ? base.total : 1,
      total: base.total > 0 ? base.total : 1,
      failed: 0,
      percent: 100,
      startedAt: value ? validTimestamp(value.startedAt) : null,
      updatedAt,
      finishedAt: updatedAt ?? snapshot.authoritativeDate,
      message: `分钟湖已覆盖 ${snapshot.authoritativeDate}（快照 ${snapshot.lastDate}）`,
    };
  }
  if (!value) return idleMinuteProgress();
  let status = normalizeStatus(value.status);
  let message = value.message?.trim() || null;
  if ((status === 'running' || status === 'pending') && isOlderThan(value.updatedAt, now, MINUTE_STALE_MS)) {
    status = 'failed';
    message = '进度心跳超过 15 分钟未更新，任务可能已中断';
  }
  return {
    key: 'minute_lake',
    label: '分钟湖数据',
    status,
    phase: value.phase?.trim() || status,
    completed: base.completed,
    total: base.total,
    failed: base.failed,
    percent: base.total > 0 ? clampPercent((base.completed + base.failed) / base.total * 100) : status === 'completed' ? 100 : null,
    startedAt: validTimestamp(value.startedAt),
    updatedAt: validTimestamp(value.updatedAt),
    finishedAt: validTimestamp(value.finishedAt),
    message,
  };
}

export function normalizeDailyProgress(job: SyncJob | null): DataUpdateProgressItem {
  if (!job) return idleDailyProgress();
  const completed = positiveInteger(job.completedItems);
  const failed = positiveInteger(job.failedItems);
  const total = positiveInteger(job.totalItems);
  return {
    key: 'daily_kline',
    label: '个股日 K 线',
    status: normalizeStatus(job.status),
    phase: job.status === 'pending' ? '排队准备' : job.status === 'running' ? '更新行情' : job.status,
    completed,
    total,
    failed,
    percent: total > 0 ? clampPercent((completed + failed) / total * 100) : job.status === 'completed' ? 100 : null,
    startedAt: validTimestamp(job.startedAt),
    updatedAt: validTimestamp(job.finishedAt ?? job.startedAt ?? job.createdAt),
    finishedAt: validTimestamp(job.finishedAt),
    message: failed > 0 ? `${failed} 个标的更新失败` : null,
  };
}

export function normalizeFinancialProgress(run: CollectorRun | null): DataUpdateProgressItem {
  if (!run) return idleFinancialProgress();
  const details = run.details ?? {};
  const apiRows = isRecord(details.apiRows) ? details.apiRows : {};
  const completed = positiveInteger(apiRows.symbols);
  const partialSymbols = positiveInteger(apiRows.partialSymbols);
  const undisclosed = positiveInteger(apiRows.undisclosedSymbols);
  const failed = positiveInteger(apiRows.failedSymbols) + partialSymbols;
  const total = Math.max(positiveInteger(details.totalSymbols), completed + failed + undisclosed);
  const unit = details.unit === 'stock-period' ? '项（股票×报告期）' : '只';
  const reports = positiveInteger(details.normalizedReports);
  const written = positiveInteger(details.writtenReports);
  const partial = details.status === 'partial' || (run.status === 'succeeded' && failed > 0);
  const status: DataUpdateStatus = partial ? 'failed' : run.status === 'succeeded' ? 'completed' : run.status;
  const source = typeof details.source === 'string' && details.source.trim()
    ? details.source.trim()
    : null;
  const summary = status === 'failed'
    ? partial ? `财务报表部分失败：成功 ${completed} ${unit}、失败或部分完成 ${failed} ${unit}，写入 ${written} 期。`
      : summarizeLegacyFinancialError(run)
    : [
      source ? `来源 ${source}` : null,
      reports > 0 ? `标准化 ${reports} 期` : null,
      written > 0 ? `写入 ${written} 期` : null,
      undisclosed > 0 ? `${undisclosed} ${unit}尚未披露，已跳过` : null,
      failed > 0 ? `${failed} 只股票失败` : null,
    ].filter(Boolean).join(' · ') || null;
  return {
    key: 'financial_reports',
    label: '财务报表',
    status,
    phase: partial ? '部分失败' : run.status === 'running' ? '采集财务报表' : status,
    completed,
    total,
    failed,
    percent: total > 0
      ? clampPercent((completed + failed + undisclosed) / total * 100)
      : status === 'completed' ? 100 : null,
    startedAt: validTimestamp(run.startedAt),
    updatedAt: validTimestamp(run.finishedAt ?? details.updatedAt ?? run.startedAt),
    finishedAt: validTimestamp(run.finishedAt),
    message: summary,
  };
}

function summarizeLegacyFinancialError(run: CollectorRun): string {
  const message = run.errorMessage ?? '财务报表更新失败';
  if (!message.startsWith('Command failed:')) return message;
  const duration = run.finishedAt ? Date.parse(run.finishedAt) - Date.parse(run.startedAt) : 0;
  if (duration >= 1_799_000 && duration < 1_810_000) {
    return '财务报表运行约 30 分钟后终止，达到调度超时上限；历史错误日志已截断。';
  }
  return '财务报表采集进程异常退出；历史错误日志已截断，无法从启动警告判断具体原因。';
}

async function readMinuteProgress(path: string, now: Date, minute: MinuteProgressContext): Promise<DataUpdateProgressItem> {
  const [value, snapshot] = await Promise.all([
    readMinuteProgressFile(path),
    readMinuteSnapshot(minute),
  ]);
  return normalizeMinuteProgress(value, now, snapshot);
}

async function readFundFlowProgress(path: string, now: Date): Promise<DataUpdateProgressItem> {
  try {
    const [source, runStat] = await Promise.all([
      readFile(path, 'utf8'),
      stat(resolve(dirname(path), 'backfill.log')).catch(() => stat(path)),
    ]);
    const value = JSON.parse(source.replace(/^\uFEFF/, '')) as FundFlowProgressFile;
    return normalizeFundFlowProgress(value, now, value.startedAt ?? runStat.birthtime.toISOString());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return idleFundFlowProgress();
    throw error;
  }
}

async function readMinuteProgressFile(path: string): Promise<MinuteProgressFile | null> {
  try {
    const source = (await readFile(path, 'utf8')).replace(/^\uFEFF/, '');
    return JSON.parse(source) as MinuteProgressFile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function readMinuteSnapshot(minute: MinuteProgressContext): Promise<MinuteSnapshot> {
  const [lastDate, authoritativeDate] = await Promise.all([
    readMinuteManifestLastDate(minute.minuteRoot),
    minute.pool ? latestAuthoritativeDailyDate(minute.pool).catch(() => null) : Promise.resolve(null),
  ]);
  return { lastDate, authoritativeDate };
}

async function readMinuteManifestLastDate(minuteRoot: string): Promise<string | null> {
  try {
    const root = resolve(process.cwd(), minuteRoot);
    const manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8')) as {
      files?: Array<{ date?: string }>;
      years?: Array<{ lastDate?: string }>;
    };
    const files = Array.isArray(manifest.files) ? manifest.files : [];
    const dates = files.map((item) => (typeof item.date === 'string' ? item.date : '')).filter(Boolean).sort();
    if (dates.length > 0) return dates[dates.length - 1];
    const years = Array.isArray(manifest.years) ? manifest.years : [];
    return years.map((item) => item.lastDate ?? '').filter(Boolean).sort().at(-1) ?? null;
  } catch {
    return null;
  }
}

async function latestAuthoritativeDailyDate(pool: Pool): Promise<string | null> {
  const [rows] = await pool.query<RowDataPacket[]>(
    "SELECT DATE_FORMAT(MAX(trade_date), '%Y-%m-%d') AS maxDate FROM daily_candles",
  );
  return typeof rows[0]?.maxDate === 'string' && rows[0].maxDate ? rows[0].maxDate : null;
}

async function readDailyProgress(): Promise<DataUpdateProgressItem> {
  const result = await listSyncJobs({ jobType: 'incremental', limit: 1 });
  return normalizeDailyProgress(result.data[0] ?? null);
}

async function readInstrumentProgress(): Promise<DataUpdateProgressItem> {
  const result = await listSyncJobs({ jobType: 'instruments', limit: 1 });
  return normalizeInstrumentProgress(result.data[0] ?? null);
}

async function readFinancialProgress(): Promise<DataUpdateProgressItem> {
  const runs = await latestCollectorRuns();
  return normalizeFinancialProgress(runs.find((run) => run.jobType === 'financial_reports') ?? null);
}

function idleMinuteProgress(): DataUpdateProgressItem {
  return { key: 'minute_lake', label: '分钟湖数据', status: 'idle', phase: '等待计划任务', completed: 0, total: 0, failed: 0, percent: null, startedAt: null, updatedAt: null, finishedAt: null, message: null };
}

function idleFundFlowProgress(message: string | null = null): DataUpdateProgressItem {
  return {
    key: 'fund_flow',
    label: '个股资金流',
    status: 'idle',
    phase: '等待资金流更新',
    completed: 0,
    total: 0,
    failed: 0,
    percent: null,
    startedAt: null,
    updatedAt: null,
    finishedAt: null,
    message,
    currentDate: null,
    processedRows: null,
    etaAt: null,
  };
}

function idleInstrumentProgress(message: string | null = null): DataUpdateProgressItem {
  return {
    key: 'instrument_master',
    label: '证券主表',
    status: 'idle',
    phase: '等待证券名单更新',
    completed: 0,
    total: 0,
    failed: 0,
    percent: null,
    startedAt: null,
    updatedAt: null,
    finishedAt: null,
    message,
  };
}

function idleDailyProgress(message: string | null = null): DataUpdateProgressItem {
  return { key: 'daily_kline', label: '个股日 K 线', status: 'idle', phase: '等待盘后更新', completed: 0, total: 0, failed: 0, percent: null, startedAt: null, updatedAt: null, finishedAt: null, message };
}

function idleFinancialProgress(message: string | null = null): DataUpdateProgressItem {
  return { key: 'financial_reports', label: '财务报表', status: 'idle', phase: '等待财报更新', completed: 0, total: 0, failed: 0, percent: null, startedAt: null, updatedAt: null, finishedAt: null, message };
}

function failedDailyProgress(error: unknown): DataUpdateProgressItem {
  return { ...idleDailyProgress(), status: 'failed', phase: '读取进度失败', message: error instanceof Error ? error.message : String(error) };
}

function failedInstrumentProgress(error: unknown): DataUpdateProgressItem {
  return {
    ...idleInstrumentProgress(),
    status: 'failed',
    phase: '读取进度失败',
    message: error instanceof Error ? error.message : String(error),
  };
}

function failedFinancialProgress(error: unknown): DataUpdateProgressItem {
  return { ...idleFinancialProgress(), status: 'failed', phase: '读取进度失败', message: error instanceof Error ? error.message : String(error) };
}

function failedMinuteProgress(error: unknown): DataUpdateProgressItem {
  return { ...idleMinuteProgress(), status: 'failed', phase: '读取进度失败', message: error instanceof Error ? error.message : String(error) };
}

function failedFundFlowProgress(error: unknown): DataUpdateProgressItem {
  return { ...idleFundFlowProgress(), status: 'failed', phase: '读取进度失败', message: error instanceof Error ? error.message : String(error) };
}

function normalizeStatus(value: unknown): DataUpdateStatus {
  return ['pending', 'running', 'completed', 'failed', 'cancelled'].includes(String(value))
    ? value as DataUpdateStatus
    : 'idle';
}

function positiveInteger(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value * 10) / 10));
}

function validTimestamp(value: unknown): string | null {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
}

function isOlderThan(value: unknown, now: Date, maxAgeMs: number): boolean {
  const timestamp = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return !Number.isFinite(timestamp) || now.getTime() - timestamp > maxAgeMs;
}

function estimateCompletionTime(startedAt: string | null, now: Date, completed: number, total: number): string | null {
  const started = startedAt ? Date.parse(startedAt) : Number.NaN;
  if (!Number.isFinite(started) || completed <= 0 || total <= completed) return null;
  const elapsed = now.getTime() - started;
  if (elapsed <= 0) return null;
  const remainingMs = elapsed / completed * (total - completed);
  return new Date(now.getTime() + remainingMs).toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
