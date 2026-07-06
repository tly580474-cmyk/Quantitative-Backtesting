// ─── Sync Scheduler ────────────────────────────────────────────────
// Scheduled execution manager for periodic market data sync jobs.
// Uses setInterval to periodically check if a daily incremental sync
// should run, and exposes a manual trigger for ad-hoc syncs.

import type {
  SyncJobType,
  SyncRequestSnapshot,
  SyncJob,
} from '../types.js';
import { getProvider } from '../providers/providerRegistry.js';
import { acquireLock, bindLockToJob, releaseLock } from './jobLock.js';
import { executeSyncJob } from './syncExecutor.js';
import {
  getTradeDateStatus,
  upsertCalendarEntries,
} from '../repositories/calendarRepository.js';
import {
  createSyncJob,
  listSyncJobs,
} from '../repositories/syncJobRepository.js';
import { getChinaMarketSession, shouldRunIntradaySlot } from './marketSession.js';

// ─── Types ──────────────────────────────────────────────────────────

export interface SchedulerConfig {
  enabled: boolean;
  dailySyncTime: string; // HH:mm format, e.g. "18:30"
  markets: string[];
  providerId: string;
  intradayIntervalMinutes: number;
}

interface SchedulerState {
  config: SchedulerConfig;
  intervalId: ReturnType<typeof setInterval> | null;
  running: boolean;
  lastTriggeredSlot: string | null;
}

// ─── State ──────────────────────────────────────────────────────────

const state: SchedulerState = {
  config: {
    enabled: false,
    dailySyncTime: '18:30',
    markets: [],
    providerId: '',
    intradayIntervalMinutes: 30,
  },
  intervalId: null,
  running: false,
  lastTriggeredSlot: null,
};

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Starts the scheduler with the given configuration.
 *
 * The scheduler checks every 60 seconds whether:
 * 1. The scheduler is enabled
 * 2. The current time matches config.dailySyncTime (within the check minute)
 * 3. Today is a trading day
 * 4. A sync of the same type is not already running (via jobLock)
 *
 * If all conditions pass, it creates and executes a daily incremental
 * sync job.
 */
export function startScheduler(config: SchedulerConfig): void {
  if (state.intervalId !== null) {
    console.warn('[syncScheduler] Scheduler is already running. Call stopScheduler() first.');
    return;
  }

  state.config = { ...config };
  state.running = true;

  const intervalMs = 60_000; // Check every minute

  state.intervalId = setInterval(async () => {
    try {
      await schedulerTick();
    } catch (err) {
      console.error('[syncScheduler] Error during scheduler tick:', err);
    }
  }, intervalMs);

  // Check immediately so a service restart at/after the configured close time
  // does not postpone the update until the next trading day.
  void schedulerTick().catch((err) => {
    console.error('[syncScheduler] Error during startup tick:', err);
  });

  console.log(
    `[syncScheduler] Started. Daily sync at ${config.dailySyncTime}, ` +
    `markets: [${config.markets.join(', ')}]`,
  );
}

/**
 * Stops the scheduler, cancelling the interval timer.
 */
export function stopScheduler(): void {
  if (state.intervalId !== null) {
    clearInterval(state.intervalId);
    state.intervalId = null;
  }
  state.running = false;
  console.log('[syncScheduler] Stopped.');
}

/**
 * Returns whether the scheduler is currently active.
 */
export function isSchedulerRunning(): boolean {
  return state.running;
}

/**
 * Manually triggers a sync job of the given type and returns the job ID.
 *
 * This bypasses the scheduler's time-based triggers and runs immediately.
 * It does NOT check today-is-trading-day or daily-already-completed,
 * allowing the caller to decide those constraints.
 *
 * @param jobType - The type of sync to run
 * @param request - Parameters for the sync (market, symbols, date range)
 * @param providerId - Optional override for provider (uses scheduler config default)
 * @returns The ID of the created sync job
 */
export async function runManualSync(
  jobType: SyncJobType,
  request: SyncRequestSnapshot,
  providerId?: string,
): Promise<string> {
  const effectiveProviderId = providerId ?? state.config.providerId;
  if (!effectiveProviderId) {
    throw new Error(
      'No providerId configured. Provide a providerId parameter or ' +
      'start the scheduler with a default providerId.',
    );
  }

  const provider = getProvider(effectiveProviderId);
  if (!provider) {
    throw new Error(`Provider not found: ${effectiveProviderId}`);
  }

  // Acquire lock to prevent duplicate sync of same type
  const lockAcquired = await acquireLock(jobType);
  if (!lockAcquired) {
    throw new Error(
      `Cannot start ${jobType} sync: a sync of this type is already running.`,
    );
  }

  try {
    // Create the job record
    const jobId = crypto.randomUUID();
    const now = new Date().toISOString();

    await createSyncJob({
      id: jobId,
      jobType,
      status: 'pending',
      providerId: effectiveProviderId,
      requestSnapshot: request,
      totalItems: 0,
      completedItems: 0,
      failedItems: 0,
      createdAt: now,
    } as SyncJob);

    bindLockToJob(jobType, jobId);

    // Fetch the created job to pass to executor
    const { getSyncJob } = await import('../repositories/syncJobRepository.js');
    const job = await getSyncJob(jobId);
    if (!job) {
      throw new Error(`Failed to retrieve created job: ${jobId}`);
    }

    // Execute asynchronously — don't await, let it run in background
    executeSyncJob(job, provider)
      .then((result) => {
        console.log(
          `[syncScheduler] Manual sync ${jobId} completed: ` +
          `${result.succeeded} succeeded, ${result.failed} failed`,
        );
      })
      .catch((err) => {
        console.error(`[syncScheduler] Manual sync ${jobId} failed:`, err);
      })
      .finally(async () => {
        await releaseLock(jobType);
      });

    return jobId;
  } catch (err) {
    await releaseLock(jobType);
    throw err;
  }
}

// ─── Internal Tick Logic ────────────────────────────────────────────

/**
 * Called on each scheduler interval tick. Checks conditions and starts
 * a daily incremental sync if appropriate.
 */
async function schedulerTick(): Promise<void> {
  const config = state.config;

  if (!config.enabled) return;
  if (config.markets.length === 0) return;

  const now = new Date();
  const session = getChinaMarketSession(now);
  const currentTime = `${String(Math.floor(session.minuteOfDay / 60)).padStart(2, '0')}:${String(session.minuteOfDay % 60).padStart(2, '0')}`;
  const closeSlotKey = `${session.tradeDate}:close`;
  const isCloseRun = state.lastTriggeredSlot !== closeSlotKey
    && isScheduledCloseDue(session.minuteOfDay, config.dailySyncTime);
  const isIntradayRun = shouldRunIntradaySlot(
    session,
    config.intradayIntervalMinutes,
  );
  if (!isCloseRun && !isIntradayRun) return;
  const trigger = isCloseRun ? 'close' : 'intraday';
  const slotKey = isCloseRun
    ? closeSlotKey
    : `${session.tradeDate}:${trigger}:${currentTime}`;
  if (state.lastTriggeredSlot === slotKey) return;

  // Check if today is a trading day for any of the configured markets
  const today = session.tradeDate;
  const anyMarketOpen = await resolveChinaTradingDay(config, today);

  if (!anyMarketOpen) {
    console.log(`[syncScheduler] ${today} is not a trading day for configured markets. Skipping.`);
    return;
  }

  // Only the closing run is once-per-day. Intraday slots intentionally repeat.
  const alreadyCompleted = isCloseRun
    && await hasCompletedSyncToday('incremental', 'close');
  if (alreadyCompleted) {
    state.lastTriggeredSlot = slotKey;
    console.log('[syncScheduler] Closing incremental sync already completed today. Skipping.');
    return;
  }

  // Try to start the incremental sync
  try {
    const jobId = await runDailyIncrementalSync(config, {
      markets: config.markets,
      trigger,
      finalizeDailyBar: isCloseRun || session.isDailyBarFinal,
    });
    state.lastTriggeredSlot = slotKey;
    console.log(`[syncScheduler] Started daily incremental sync: ${jobId}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[syncScheduler] Could not start daily sync: ${message}`);
  }
}

async function resolveChinaTradingDay(
  config: SchedulerConfig,
  tradeDate: string,
): Promise<boolean> {
  const statuses = await Promise.all(
    config.markets.map((market) => getTradeDateStatus(market, tradeDate)),
  );
  const knownStatuses = statuses.filter((status): status is boolean => status !== null);
  if (knownStatuses.length > 0) {
    return knownStatuses.some(Boolean);
  }

  // Bootstrap a missing calendar from the live provider. Chinese exchanges
  // share the same trading dates, so one SH benchmark request covers SH/SZ/BJ.
  const provider = getProvider(config.providerId);
  if (!provider) {
    throw new Error(`Provider not found: ${config.providerId}`);
  }
  const days = await provider.fetchTradingCalendar({
    market: 'SH',
    startDate: tradeDate,
    endDate: tradeDate,
  });
  const isOpen = days.find((day) => day.date === tradeDate)?.isOpen ?? false;
  await upsertCalendarEntries(config.markets.map((market) => ({
    id: crypto.randomUUID(),
    market: market as 'SH' | 'SZ' | 'BJ',
    tradeDate,
    isOpen,
    sessionMetadata: {
      source: config.providerId,
      bootstrappedBy: 'syncScheduler',
    },
  })), config.providerId);
  console.log(
    `[syncScheduler] Bootstrapped ${tradeDate} calendar for ` +
    `[${config.markets.join(', ')}]: ${isOpen ? 'open' : 'closed'}`,
  );
  return isOpen;
}

export function isScheduledCloseDue(
  currentMinuteOfDay: number,
  scheduledTime: string,
): boolean {
  const match = /^(\d{2}):(\d{2})$/.exec(scheduledTime);
  if (!match) return false;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return false;
  return currentMinuteOfDay >= hour * 60 + minute;
}

/**
 * Creates and kicks off the daily incremental sync job.
 */
async function runDailyIncrementalSync(
  config: SchedulerConfig,
  requestSnapshot: SyncRequestSnapshot,
): Promise<string> {
  const jobType: SyncJobType = 'incremental';
  const lockAcquired = await acquireLock(jobType);

  if (!lockAcquired) {
    throw new Error('Incremental sync is already running.');
  }

  try {
    const provider = getProvider(config.providerId);
    if (!provider) {
      throw new Error(`Provider not found: ${config.providerId}`);
    }

    const jobId = crypto.randomUUID();
    const now = new Date().toISOString();

    await createSyncJob({
      id: jobId,
      jobType,
      status: 'pending',
      providerId: config.providerId,
      requestSnapshot,
      totalItems: 0,
      completedItems: 0,
      failedItems: 0,
      createdAt: now,
    } as SyncJob);

    bindLockToJob(jobType, jobId);

    const { getSyncJob } = await import('../repositories/syncJobRepository.js');
    const job = await getSyncJob(jobId);
    if (!job) {
      throw new Error(`Failed to retrieve created job: ${jobId}`);
    }

    // Execute in background
    executeSyncJob(job, provider)
      .then((result) => {
        console.log(
          `[syncScheduler] Daily incremental sync ${jobId} completed: ` +
          `${result.succeeded} succeeded, ${result.failed} failed`,
        );
      })
      .catch((err) => {
        console.error(
          `[syncScheduler] Daily incremental sync ${jobId} failed:`,
          err,
        );
      })
      .finally(async () => {
        await releaseLock(jobType);
      });

    return jobId;
  } catch (err) {
    await releaseLock(jobType);
    throw err;
  }
}

/**
 * Checks whether a sync job of the given type has already completed
 * today. Used to prevent redundant daily syncs.
 */
async function hasCompletedSyncToday(
  jobType: SyncJobType,
  trigger?: SyncRequestSnapshot['trigger'],
): Promise<boolean> {
  const today = getChinaMarketSession().tradeDate;

  const { data: jobs } = await listSyncJobs({
    jobType,
    status: 'completed',
    limit: 20,
  });

  return jobs.some((job) => {
    const finishedDate = (job.finishedAt ?? job.createdAt).slice(0, 10);
    return finishedDate === today
      && (!trigger || job.requestSnapshot.trigger === trigger);
  });
}
