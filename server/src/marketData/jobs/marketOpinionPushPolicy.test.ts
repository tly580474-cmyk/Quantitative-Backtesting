import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startMarketOpinionPushScheduler, stopMarketOpinionPushScheduler } from './marketOpinionPushScheduler.js';
import type { MarketOpinionPushService } from '../../services/marketOpinionPushService.js';

const repository = vi.hoisted(() => ({
  expireStaleCollectorRuns: vi.fn(), finishCollectorRun: vi.fn(),
  tryStartCollectorRun: vi.fn(), updateCollectorRunDetails: vi.fn(),
}));
vi.mock('../repositories/collectorRunRepository.js', () => repository);
const schedule = { times: { morning: '09:00', midday: '12:00', close: '16:00' }, graceMinutes: 20 };

describe('scheduled holiday push policy', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-01T04:05:00Z'));
    vi.clearAllMocks();
    repository.tryStartCollectorRun.mockResolvedValue(true);
  });
  afterEach(() => { stopMarketOpinionPushScheduler(); vi.useRealTimers(); });

  it('skips before acquiring a delivery run on a holiday', async () => {
    const service = { dayMode: vi.fn().mockResolvedValue('skip'), send: vi.fn() };
    startMarketOpinionPushScheduler(service as unknown as MarketOpinionPushService, schedule);
    await vi.advanceTimersByTimeAsync(0);
    expect(service.dayMode).toHaveBeenCalledOnce();
    expect(repository.tryStartCollectorRun).not.toHaveBeenCalled();
    expect(service.send).not.toHaveBeenCalled();
  });

  it('allows weekend news reports when the option is disabled and keeps the deduplication key', async () => {
    vi.setSystemTime(new Date('2026-10-04T04:05:00Z'));
    repository.tryStartCollectorRun.mockResolvedValueOnce(true).mockResolvedValue(false);
    const service = { dayMode: vi.fn().mockResolvedValue('non_trading'), send: vi.fn().mockResolvedValue({ kind: 'midday' }) };
    startMarketOpinionPushScheduler(service as unknown as MarketOpinionPushService, schedule);
    await vi.advanceTimersByTimeAsync(0);
    expect(repository.tryStartCollectorRun).toHaveBeenCalledWith('market_opinion_push:2026-10-04:midday', 'market_opinion_push', expect.any(Object));
    expect(repository.finishCollectorRun).toHaveBeenCalledWith('market_opinion_push:2026-10-04:midday', 'succeeded', expect.any(Object));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(service.send).toHaveBeenCalledOnce();
  });

  it('handles a calendar error without sending or leaving the scheduler stuck', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const service = { dayMode: vi.fn().mockRejectedValueOnce(new Error('calendar unavailable')).mockResolvedValue('non_trading'),
      send: vi.fn().mockResolvedValue({ kind: 'midday' }) };
    startMarketOpinionPushScheduler(service as unknown as MarketOpinionPushService, schedule);
    await vi.advanceTimersByTimeAsync(0);
    expect(service.send).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(service.send).toHaveBeenCalledOnce();
    log.mockRestore();
  });
});
