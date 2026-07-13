import { join, resolve } from 'node:path';
import { openManagedDuckDB } from '../../research/duckdbRuntime.js';
import { readCurrentSnapshot } from '../../research/snapshotManifest.js';
import {
  createMiningTask, listMiningSchedules, updateMiningSchedule,
} from '../candidates/candidateRepository.js';
import { startMiningWorker, type MiningWorkerOptions } from './miningWorker.js';
import {
  hasMinimumLockedTestCalendarSpan,
  MIN_LOCKED_TEST_SAMPLES,
  MIN_LOCKED_TEST_TRADING_DAYS,
} from '../candidates/lockedTestValidation.js';

let timer: NodeJS.Timeout | null = null;
let ticking = false;
const windowCoverageCache = new Map<string, { rows: number; tradingDays: number }>();

export function startMiningScheduler(options: MiningWorkerOptions, intervalMs = 300_000): void {
  if (timer) return;
  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try { await runMiningScheduleTick(options); }
    catch (error) { console.error('[factorMiningScheduler]', error); }
    finally { ticking = false; }
  };
  timer = setInterval(() => { void tick(); }, Math.max(30_000, intervalMs));
  void tick();
}

export function stopMiningScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export async function runMiningScheduleTick(options: MiningWorkerOptions): Promise<number> {
  const current = await readCurrentSnapshot(options.snapshotRoot);
  if (!current) return 0;
  const schedules = await listMiningSchedules(true);
  let launched = 0;
  for (const schedule of schedules) {
    if (!shouldLaunchForSnapshot(schedule.lastSnapshotId, current.manifest.snapshotId)) continue;
    const priorTestEndDate = schedule.lastTestEndDate ?? current.manifest.minDate;
    if (!hasMinimumLockedTestCalendarSpan(priorTestEndDate, current.manifest.maxDate)) continue;
    const coverage = await readScheduledWindowCoverage(options.snapshotRoot,
      current.manifest.snapshotId, priorTestEndDate, current.manifest.maxDate);
    if (coverage.rows < MIN_LOCKED_TEST_SAMPLES
      || coverage.tradingDays < MIN_LOCKED_TEST_TRADING_DAYS) continue;
    const task = await createMiningTask({
      snapshotId: current.manifest.snapshotId,
      config: rollScheduledSplit(schedule.config as Record<string, unknown>,
        priorTestEndDate),
      lineage: { scheduleId: schedule.id, sourceVersion: current.manifest.sourceVersion,
        priorSnapshotId: schedule.lastSnapshotId },
      totalGenerations: schedule.totalGenerations,
    });
    try {
      await startMiningWorker(task.id, options);
      await updateMiningSchedule(schedule.id, {
        lastSnapshotId: current.manifest.snapshotId, lastTestEndDate: current.manifest.maxDate,
        lastTaskId: task.id,
      });
      launched += 1;
    } catch (error) {
      console.error(`[factorMiningScheduler] schedule=${schedule.id}`, error);
    }
  }
  return launched;
}

export function shouldLaunchForSnapshot(lastSnapshotId: string | null, currentSnapshotId: string): boolean {
  return Boolean(currentSnapshotId) && lastSnapshotId !== currentSnapshotId;
}

export function rollScheduledSplit(config: Record<string, unknown>, priorTestEndDate: string) {
  const prior = new Date(`${priorTestEndDate}T00:00:00.000Z`);
  const trainEnd = new Date(prior);
  trainEnd.setUTCFullYear(trainEnd.getUTCFullYear() - 2);
  return {
    ...config,
    data: { ...asRecord(config.data), train_end: trainEnd.toISOString().slice(0, 10),
      valid_end: priorTestEndDate },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

async function readScheduledWindowCoverage(
  snapshotRoot: string,
  snapshotId: string,
  priorEndDate: string,
  currentEndDate: string,
): Promise<{ rows: number; tradingDays: number }> {
  const cacheKey = `${snapshotId}:${priorEndDate}:${currentEndDate}`;
  const cached = windowCoverageCache.get(cacheKey);
  if (cached) return cached;
  const parquetGlob = join(resolve(snapshotRoot), snapshotId, 'bars', 'year=*', '*.parquet')
    .replaceAll('\\', '/');
  const session = await openManagedDuckDB({ label: 'mining-window-coverage',
    config: { threads: '1', max_memory: '256MB' } });
  const { connection } = session;
  try {
    const reader = await connection.runAndReadAll(`
      SELECT COUNT(*) AS rowCount, COUNT(DISTINCT tradeDate) AS tradingDays
      FROM read_parquet('${parquetGlob.replaceAll("'", "''")}', hive_partitioning = true)
      WHERE tradeDate > $priorEndDate AND tradeDate <= $currentEndDate
    `, { priorEndDate, currentEndDate });
    const row = reader.getRowObjectsJson()[0] ?? {};
    const coverage = { rows: Number(row.rowCount ?? 0), tradingDays: Number(row.tradingDays ?? 0) };
    windowCoverageCache.set(cacheKey, coverage);
    return coverage;
  } finally {
    await session.close();
  }
}
