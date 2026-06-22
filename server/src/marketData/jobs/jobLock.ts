// ─── Distributed Job Lock ──────────────────────────────────────────
// Uses the sync_jobs table as a table-based advisory lock to prevent
// duplicate sync execution for the same job type.

import { getRunningJob } from '../repositories/syncJobRepository.js';

// ─── Types ──────────────────────────────────────────────────────────

export interface LockHandle {
  lockName: string;
  jobId: string;
  acquiredAt: string;
}

// ─── Active Locks (in-process) ──────────────────────────────────────

const activeLocks = new Map<string, LockHandle>();

// ─── Lock Operations ────────────────────────────────────────────────

/**
 * Attempts to acquire a lock for a given job type (lockName).
 *
 * Checks the database for any existing sync job of the same type
 * that is currently in 'running' status. If one exists, the lock
 * cannot be acquired and returns false.
 *
 * This is a cooperative lock — callers must check return value and
 * must call releaseLock when done.
 *
 * @param lockName - Typically the SyncJobType (e.g. 'incremental')
 * @param ttlMs - Time-to-live in ms (not used in table-based approach,
 *   but kept for interface compatibility; stale locks should be handled
 *   by monitoring job duration)
 * @returns true if lock was acquired, false if already locked
 */
export async function acquireLock(
  lockName: string,
  ttlMs?: number,
): Promise<boolean> {
  // Check in-process cache first (fast path)
  if (activeLocks.has(lockName)) {
    return false;
  }

  // Check database for any running job of the same type
  const existingRunning = await getRunningJob(lockName);
  if (existingRunning) {
    return false;
  }

  // Lock acquired — record in-process (the actual job record will be
  // created by the sync executor or scheduler when the job starts).
  // We track the lock name here; the jobId is assigned when the
  // sync job row is inserted.
  activeLocks.set(lockName, {
    lockName,
    jobId: '', // assigned when the sync job is created
    acquiredAt: new Date().toISOString(),
  });

  return true;
}

/**
 * Updates a lock handle with the actual job ID once the sync job
 * record has been created in the database.
 */
export function bindLockToJob(lockName: string, jobId: string): void {
  const handle = activeLocks.get(lockName);
  if (handle) {
    handle.jobId = jobId;
  }
}

/**
 * Releases the lock for the given lock name.
 * Removes it from the in-process cache.
 */
export async function releaseLock(lockName: string): Promise<void> {
  activeLocks.delete(lockName);
}

/**
 * Checks whether a lock is currently held for the given name.
 * Checks both the in-process cache and the database.
 */
export async function isLocked(lockName: string): Promise<boolean> {
  // Check in-process
  if (activeLocks.has(lockName)) {
    return true;
  }

  // Check database
  const existingRunning = await getRunningJob(lockName);
  return !!existingRunning;
}

/**
 * Returns all currently held lock names (for diagnostics).
 */
export function getActiveLockNames(): string[] {
  return Array.from(activeLocks.keys());
}

/**
 * Releases all locks held by this process.
 * Useful during graceful shutdown.
 */
export async function releaseAllLocks(): Promise<void> {
  activeLocks.clear();
}
