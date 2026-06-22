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
import { isTradeDate } from '../repositories/calendarRepository.js';
import {
  createSyncJob,
  listSyncJobs,
} from '../repositories/syncJobRepository.js';

// ─── Types ──────────────────────────────────────────────────────────

export interface SchedulerConfig {
  enabled: boolean;
  dailySyncTime: string; // HH:mm format, e.g. "18:30"
  markets: string[];
  providerId: string;
}

interface SchedulerState {
  config: SchedulerConfig;
  intervalId: ReturnType<typeof setInterval> | null;
  running: boolean;
}

// ─── State ──────────────────────────────────────────────────────────

const state: SchedulerState = {
  config: {
    enabled: false,
    dailySyncTime: '18:30',
    markets: [],
    providerId: '',
  },
  intervalId: null,
  running: false,
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

  // Check if current time matches the configured daily sync time
  const now = new Date();
  const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  if (currentTime !== config.dailySyncTime) {
    return; // Not time yet
  }

  // Check if today is a trading day for any of the configured markets
  const today = now.toISOString().slice(0, 10);
  let anyMarketOpen = false;

  for (const market of config.markets) {
    try {
      if (await isTradeDate(market, today)) {
        anyMarketOpen = true;
        break;
      }
    } catch {
      // Calendar data might not exist yet — skip this market
      continue;
    }
  }

  if (!anyMarketOpen) {
    console.log(`[syncScheduler] ${today} is not a trading day for configured markets. Skipping.`);
    return;
  }

  // Check if an incremental sync already completed today
  const alreadyCompleted = await hasCompletedSyncToday('incremental');
  if (alreadyCompleted) {
    console.log(`[syncScheduler] Incremental sync already completed today. Skipping.`);
    return;
  }

  // Try to start the incremental sync
  try {
    const jobId = await runDailyIncrementalSync(config);
    console.log(`[syncScheduler] Started daily incremental sync: ${jobId}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[syncScheduler] Could not start daily sync: ${message}`);
  }
}

/**
 * Creates and kicks off the daily incremental sync job.
 */
async function runDailyIncrementalSync(config: SchedulerConfig): Promise<string> {
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

    const requestSnapshot: SyncRequestSnapshot = {
      market: config.markets[0],
    };

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
): Promise<boolean> {
  const today = new Date().toISOString().slice(0, 10);

  const { data: jobs } = await listSyncJobs({
    jobType,
    status: 'completed',
    limit: 20,
  });

  return jobs.some((job) => {
    const finishedDate = (job.finishedAt ?? job.createdAt).slice(0, 10);
    return finishedDate === today;
  });
}
