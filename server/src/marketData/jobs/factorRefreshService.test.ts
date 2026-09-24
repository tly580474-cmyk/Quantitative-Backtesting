import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MarketDataProvider } from '../providers/provider.js';

const repository = vi.hoisted(() => ({ getPublishedFactorState: vi.fn(), getHistoryDailyBarsInRange: vi.fn(), publishHistoryAdjustment: vi.fn() }));
vi.mock('../repositories/marketDataRepository.js', () => repository);
import { adjustmentRefreshStart, refreshAdjustmentAfterCorporateAction } from './factorRefreshService.js';

const raw = [
  { tradeDate: '2026-07-09', open: 10, high: 11, low: 9, close: 10 },
  { tradeDate: '2026-07-10', open: 10, high: 12, low: 9, close: 11 },
];
const fetchDailyCandles = vi.fn();
const input = { instrumentId: 'test', instrumentKey: 1, symbol: '000001', market: 'SZ', tradeDate: '2026-09-22',
  storedPreviousClose: 10, officialPreviousClose: 9.5,
  provider: { id: 'tencent', fetchDailyCandles } as unknown as MarketDataProvider };
beforeEach(() => {
  vi.resetAllMocks();
  repository.getPublishedFactorState.mockResolvedValue({ publication: { lastCheckedDate: '2026-07-04' },
    factors: [{ effectiveDate: '2020-01-01', factor: 1, offset: 0 }] });
  repository.getHistoryDailyBarsInRange.mockResolvedValue(raw);
  fetchDailyCandles.mockResolvedValue(raw.map(({ tradeDate, ...row }) => ({ date: tradeDate, ...row })));
});
describe('factor refresh guardrails', () => {
  it('includes the stale checked date instead of losing events outside the fixed recent window', () => {
    expect(adjustmentRefreshStart('2026-09-22', '2026-07-04')).toBe('2026-06-20');
    expect(adjustmentRefreshStart('2026-09-22', '2026-09-21')).toBe('2026-07-09');
  });
  it('qualifies Shenzhen stock codes so they cannot resolve to Shanghai indices', async () => {
    await refreshAdjustmentAfterCorporateAction(input);
    expect(fetchDailyCandles).toHaveBeenCalledWith(expect.objectContaining({ symbols: ['000001.SZ'], startDate: '2026-06-20' }));
    expect(repository.publishHistoryAdjustment).not.toHaveBeenCalled();
  });
  it('surfaces failed validation to the quality-issue caller and never publishes it', async () => {
    fetchDailyCandles.mockResolvedValue([]);
    await expect(refreshAdjustmentAfterCorporateAction(input)).rejects.toThrow('insufficient_reference');
    expect(repository.publishHistoryAdjustment).not.toHaveBeenCalled();
  });
  it('does not silently accept a missing baseline', async () => {
    repository.getPublishedFactorState.mockResolvedValue(null);
    await expect(refreshAdjustmentAfterCorporateAction(input)).rejects.toThrow('missing_baseline');
    expect(fetchDailyCandles).not.toHaveBeenCalled();
  });
});
