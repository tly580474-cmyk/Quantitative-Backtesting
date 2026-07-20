import { describe, expect, it } from 'vitest';
import type { SyncJob } from '../marketData/types.js';
import { normalizeDailyProgress, normalizeMinuteProgress } from './dataUpdateProgress.js';

describe('admin data update progress', () => {
  it('converts minute updater heartbeats into a determinate progress item', () => {
    const progress = normalizeMinuteProgress({
      status: 'running', phase: 'fetching-online', completed: 1250, total: 5000,
      failed: 5, updatedAt: '2026-07-20T08:31:00.000Z', startedAt: '2026-07-20T08:30:00.000Z',
    }, new Date('2026-07-20T08:32:00.000Z'));
    expect(progress.status).toBe('running');
    expect(progress.percent).toBe(25.1);
    expect(progress.failed).toBe(5);
  });

  it('marks a silent running minute task as interrupted', () => {
    const progress = normalizeMinuteProgress({
      status: 'running', phase: 'fetching-online', updatedAt: '2026-07-20T08:00:00.000Z',
    }, new Date('2026-07-20T08:20:01.000Z'));
    expect(progress.status).toBe('failed');
    expect(progress.message).toContain('可能已中断');
  });

  it('maps daily K-line sync job counters without a second progress store', () => {
    const progress = normalizeDailyProgress({
      id: 'job-1', jobType: 'incremental', status: 'running', providerId: 'test', requestSnapshot: {},
      totalItems: 5000, completedItems: 3000, failedItems: 25,
      startedAt: '2026-07-20T07:31:00.000Z', createdAt: '2026-07-20T07:30:00.000Z',
    } as SyncJob);
    expect(progress.percent).toBe(60.5);
    expect(progress.phase).toBe('更新行情');
  });
});
