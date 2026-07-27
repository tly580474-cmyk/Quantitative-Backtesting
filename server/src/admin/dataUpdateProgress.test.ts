import { describe, expect, it } from 'vitest';
import type { SyncJob } from '../marketData/types.js';
import type { CollectorRun } from '../marketData/repositories/collectorRunRepository.js';
import {
  normalizeDailyProgress,
  normalizeFinancialProgress,
  normalizeInstrumentProgress,
  normalizeMinuteProgress,
} from './dataUpdateProgress.js';

describe('admin data update progress', () => {
  it('shows the latest full-market instrument reconciliation', () => {
    const progress = normalizeInstrumentProgress({
      id: 'instrument-job',
      jobType: 'instruments',
      status: 'completed',
      providerId: 'sina-instruments',
      requestSnapshot: {},
      totalItems: 5532,
      completedItems: 5532,
      failedItems: 0,
      createdAt: '2026-07-27T02:32:30.000Z',
      finishedAt: '2026-07-27T02:32:59.000Z',
    } as SyncJob);
    expect(progress.key).toBe('instrument_master');
    expect(progress.percent).toBe(100);
    expect(progress.message).toContain('5532');
  });

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

  it('maps the latest financial collector run into the automatic update list', () => {
    const progress = normalizeFinancialProgress({
      runKey: 'financial_reports:2026-07-24:19:00',
      jobType: 'financial_reports',
      status: 'succeeded',
      attempts: 1,
      startedAt: '2026-07-24T11:00:00.000Z',
      finishedAt: '2026-07-24T11:04:00.000Z',
      details: {
        source: 'sina',
        apiRows: { symbols: 198, failedSymbols: 2 },
        normalizedReports: 2400,
        writtenReports: 2390,
      },
    } satisfies CollectorRun);
    expect(progress.key).toBe('financial_reports');
    expect(progress.status).toBe('completed');
    expect(progress.total).toBe(200);
    expect(progress.completed).toBe(198);
    expect(progress.failed).toBe(2);
    expect(progress.percent).toBe(100);
    expect(progress.message).toContain('写入 2390 期');
  });

  it('shows an idle financial item before the first scheduled run', () => {
    const progress = normalizeFinancialProgress(null);
    expect(progress.status).toBe('idle');
    expect(progress.phase).toBe('等待财报更新');
  });
});
