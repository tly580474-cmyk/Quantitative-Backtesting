import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { apiFetch } from '../../api/client';
import { loadIndexPreview, peekIndexPreview } from './indexPreviewCache';
import { INDEX_INTRADAY_CACHE_TTL_MS, marketDataCache } from './marketDataCache';
import type { KlinePoint } from './types';

vi.mock('../../api/client', () => ({ apiFetch: vi.fn() }));
const request = vi.mocked(apiFetch);
const points = [{ date: '2026-09-21', close: 100 }, { date: '2026-09-22', close: 101 }] as KlinePoint[];
beforeEach(() => {
  request.mockReset();
  marketDataCache.indexPreviews = {};
  marketDataCache.klines = {};
  marketDataCache.klineCachedAt = {};
});
afterEach(() => vi.restoreAllMocks());

it('reuses a daily fallback on navigation without retrying the unavailable intraday feed', async () => {
  request.mockResolvedValueOnce({ items: [] }).mockResolvedValueOnce({ items: points });
  expect(await loadIndexPreview('sh000001')).toEqual(points);
  expect(peekIndexPreview('sh000001')).toEqual(points);
  expect(await loadIndexPreview('sh000001')).toEqual(points);
  expect(request).toHaveBeenCalledTimes(2);
});

it('shares an unfinished request across unmount and remount', async () => {
  let resolve!: (value: unknown) => void;
  request.mockReturnValueOnce(new Promise(done => { resolve = done; }));
  const first = loadIndexPreview('sh000001');
  const remounted = loadIndexPreview('sh000001');
  expect(first).toBe(remounted);
  resolve({ items: points });
  expect(await remounted).toEqual(points);
  expect(request).toHaveBeenCalledTimes(1);
});

it('keeps stale charts visible while refreshing and when both feeds fail', async () => {
  marketDataCache.indexPreviews.sh000001 = { items: points, checkedAt: Date.now() - INDEX_INTRADAY_CACHE_TTL_MS - 1 };
  request.mockRejectedValue(new Error('offline'));
  const refresh = loadIndexPreview('sh000001');
  expect(peekIndexPreview('sh000001')).toBe(points);
  expect(await refresh).toBe(points);
  expect(request).toHaveBeenCalledTimes(2);
});

it('manual refresh bypasses a fresh preview and replaces it with the new response', async () => {
  marketDataCache.indexPreviews.sh000001 = { items: points, checkedAt: Date.now() };
  const updated = points.map(point => ({ ...point, close: point.close + 1 }));
  request.mockResolvedValueOnce({ items: updated });
  expect(await loadIndexPreview('sh000001', true)).toEqual(updated);
  expect(peekIndexPreview('sh000001')).toEqual(updated);
  expect(request).toHaveBeenCalledTimes(1);
});
