import { describe, expect, it } from 'vitest';
import type { SyncJob } from '../marketData/types.js';
import type { CollectorRun } from '../marketData/repositories/collectorRunRepository.js';
import {
  normalizeDailyProgress,
  normalizeFinancialProgress,
  normalizeFundFlowProgress,
  normalizeInstrumentProgress,
  normalizeMinuteProgress,
} from './dataUpdateProgress.js';

describe('admin data update progress', () => {
  it('maps the Tinyshare backfill heartbeat with rows and ETA', () => {
    const progress = normalizeFundFlowProgress({
      status: 'running', phase: 'tinyshare-backfill', completed: 300, total: 4000,
      failed: 0, inserted: 520000, currentDate: '2011-04-01',
      updatedAt: '2026-08-11T01:05:00.000Z',
    }, new Date('2026-08-11T01:05:00.000Z'), '2026-08-11T01:00:00.000Z');
    expect(progress.key).toBe('fund_flow');
    expect(progress.percent).toBe(7.5);
    expect(progress.processedRows).toBe(520000);
    expect(progress.etaAt).toBeTruthy();
    expect(progress.message).toContain('2011-04-01');
  });

  it('marks a stale fund-flow backfill as interrupted', () => {
    const progress = normalizeFundFlowProgress({
      status: 'running', completed: 300, total: 4000,
      updatedAt: '2026-08-11T01:00:00.000Z',
    }, new Date('2026-08-11T01:05:01.000Z'), '2026-08-11T00:55:00.000Z');
    expect(progress.status).toBe('failed');
    expect(progress.message).toContain('可能已中断');
  });

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

  it('reports completed when the lake snapshot already covers the authoritative date', () => {
    // 在线更新大面积失败后进程退出，但 TDX 导入已将快照补齐到权威日期
    const progress = normalizeMinuteProgress({
      status: 'running', phase: 'fetching-online', completed: 277, total: 5535, failed: 2723,
      updatedAt: '2026-08-07T08:10:52.000Z', startedAt: '2026-08-07T07:40:05.000Z',
    }, new Date('2026-08-07T09:30:00.000Z'), {
      lastDate: '2026-08-07',
      authoritativeDate: '2026-08-07',
    });
    expect(progress.status).toBe('completed');
    expect(progress.percent).toBe(100);
    expect(progress.failed).toBe(0);
    expect(progress.message).toContain('分钟湖已覆盖 2026-08-07');
  });

  it('keeps the failed heartbeat verdict when the snapshot lags the authoritative date', () => {
    const progress = normalizeMinuteProgress({
      status: 'running', phase: 'fetching-online', updatedAt: '2026-08-07T08:10:52.000Z',
    }, new Date('2026-08-07T09:30:00.000Z'), {
      lastDate: '2026-08-06',
      authoritativeDate: '2026-08-07',
    });
    expect(progress.status).toBe('failed');
    expect(progress.message).toContain('可能已中断');
  });

  it('reports a completed lake from the snapshot even when no heartbeat file exists', () => {
    const progress = normalizeMinuteProgress(null, new Date('2026-08-07T09:30:00.000Z'), {
      lastDate: '2026-08-07',
      authoritativeDate: '2026-08-07',
    });
    expect(progress.status).toBe('completed');
    expect(progress.phase).toBe('快照已覆盖');
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
    expect(progress.status).toBe('failed');
    expect(progress.phase).toBe('部分失败');
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

  it('counts partial writes as failures and undisclosed reports as explicitly skipped', () => {
    const progress = normalizeFinancialProgress({
      runKey: 'financial_reports:manual', jobType: 'financial_reports', status: 'succeeded', attempts: 1,
      startedAt: '2026-08-31T07:00:00Z', details: { status: 'completed', source: 'eastmoney', unit: 'stock-period',
        totalSymbols: 5551, apiRows: { symbols: 5550, undisclosedSymbols: 1 }, writtenReports: 5557 },
    });
    expect(progress.status).toBe('completed');
    expect(progress.percent).toBe(100);
    expect(progress.completed).toBe(5550);
    expect(progress.message).toContain('尚未披露，已跳过');
    const partial = normalizeFinancialProgress({
      runKey: 'financial_reports:partial', jobType: 'financial_reports', status: 'succeeded', attempts: 1,
      startedAt: '2026-08-31T07:00:00Z', details: { totalSymbols: 2, apiRows: { symbols: 1, partialSymbols: 1 } },
    });
    expect(partial.status).toBe('failed');
    expect(partial.failed).toBe(1);
  });

  it('uses the target count and heartbeat while a financial batch is running', () => {
    const progress = normalizeFinancialProgress({
      runKey: 'financial_reports:test', jobType: 'financial_reports', status: 'running',
      attempts: 1, startedAt: '2026-08-31T11:00:00Z',
      details: { totalSymbols: 200, apiRows: { symbols: 12, failedSymbols: 2 }, updatedAt: '2026-08-31T11:05:00Z' },
    });
    expect(progress.percent).toBe(7);
    expect(progress.updatedAt).toBe('2026-08-31T11:05:00Z');
  });

  it('explains a historical timeout without repeating the truncated warning', () => {
    const progress = normalizeFinancialProgress({
      runKey: 'financial_reports:test', jobType: 'financial_reports', status: 'failed',
      attempts: 3, startedAt: '2026-08-30T12:00:20Z', finishedAt: '2026-08-30T12:30:20Z',
      errorMessage: 'Command failed: python financial_update.py\npkg_resources is deprecated\n0%|',
    });
    expect(progress.message).toContain('30 分钟');
    expect(progress.message).not.toContain('pkg_resources');
    expect(progress.percent).toBeNull();
  });
});
