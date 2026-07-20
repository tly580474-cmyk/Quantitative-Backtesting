import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { SyncJob } from '../marketData/types.js';
import { listSyncJobs } from '../marketData/repositories/syncJobRepository.js';

export type DataUpdateStatus = 'idle' | 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface DataUpdateProgressItem {
  key: 'minute_lake' | 'daily_kline';
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

const MINUTE_STALE_MS = 15 * 60_000;

export async function collectDataUpdateProgress(
  dbOnline: boolean,
  serverRoot = resolve(process.cwd().replace(/[\\/]server$/, ''), 'server'),
  now = new Date(),
): Promise<{ generatedAt: string; items: DataUpdateProgressItem[] }> {
  const [minute, daily] = await Promise.all([
    readMinuteProgress(resolve(serverRoot, '.logs', 'minute-data', 'progress.json'), now),
    dbOnline ? readDailyProgress().catch((error) => failedDailyProgress(error)) : Promise.resolve(idleDailyProgress('数据库未连接')),
  ]);
  return { generatedAt: now.toISOString(), items: [minute, daily] };
}

export function normalizeMinuteProgress(value: MinuteProgressFile | null, now = new Date()): DataUpdateProgressItem {
  if (!value) return idleMinuteProgress();
  const completed = positiveInteger(value.completed);
  const total = positiveInteger(value.total);
  const failed = positiveInteger(value.failed);
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
    completed,
    total,
    failed,
    percent: total > 0 ? clampPercent((completed + failed) / total * 100) : status === 'completed' ? 100 : null,
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

async function readMinuteProgress(path: string, now: Date): Promise<DataUpdateProgressItem> {
  try {
    const source = (await readFile(path, 'utf8')).replace(/^\uFEFF/, '');
    return normalizeMinuteProgress(JSON.parse(source) as MinuteProgressFile, now);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return idleMinuteProgress();
    return { ...idleMinuteProgress(), status: 'failed', phase: '读取进度失败', message: error instanceof Error ? error.message : String(error) };
  }
}

async function readDailyProgress(): Promise<DataUpdateProgressItem> {
  const result = await listSyncJobs({ jobType: 'incremental', limit: 1 });
  return normalizeDailyProgress(result.data[0] ?? null);
}

function idleMinuteProgress(): DataUpdateProgressItem {
  return { key: 'minute_lake', label: '分钟湖数据', status: 'idle', phase: '等待计划任务', completed: 0, total: 0, failed: 0, percent: null, startedAt: null, updatedAt: null, finishedAt: null, message: null };
}

function idleDailyProgress(message: string | null = null): DataUpdateProgressItem {
  return { key: 'daily_kline', label: '个股日 K 线', status: 'idle', phase: '等待盘后更新', completed: 0, total: 0, failed: 0, percent: null, startedAt: null, updatedAt: null, finishedAt: null, message };
}

function failedDailyProgress(error: unknown): DataUpdateProgressItem {
  return { ...idleDailyProgress(), status: 'failed', phase: '读取进度失败', message: error instanceof Error ? error.message : String(error) };
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
