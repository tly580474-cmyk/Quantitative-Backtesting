import { apiFetch } from '../../api/client';
import {
  INDEX_INTRADAY_CACHE_TTL_MS, klineCacheKey, marketDataCache,
  readIndexIntradayCache, readIndexKlineCache, writeIndexIntradayCache, writeIndexKlineCache,
} from './marketDataCache';
import type { KlinePoint } from './types';

const pending = new Map<string, Promise<KlinePoint[]>>();

/** Render the last result synchronously, even while its replacement is loading. */
export function peekIndexPreview(code: string): KlinePoint[] | undefined {
  return marketDataCache.indexPreviews[code]?.items
    ?? marketDataCache.klines[klineCacheKey(code, 'intraday')]
    ?? marketDataCache.klines[klineCacheKey(code, 'day')];
}

/** Remember the resolved fallback too, and share requests across page remounts. */
export function loadIndexPreview(code: string, force = false): Promise<KlinePoint[]> {
  const existing = pending.get(code);
  if (existing) return existing;
  const saved = marketDataCache.indexPreviews[code];
  if (!force && saved && Date.now() - saved.checkedAt < INDEX_INTRADAY_CACHE_TTL_MS) {
    return Promise.resolve(saved.items);
  }
  const task = (async () => {
    const intradayKey = klineCacheKey(code, 'intraday');
    const dayKey = klineCacheKey(code, 'day');
    let items = !force ? readIndexIntradayCache(intradayKey) : null;
    if (!items?.length) {
      try {
        items = (await apiFetch<{ items: KlinePoint[] }>(
          `/api/market-data/stocks/${code}/kline?period=intraday`,
        )).items ?? [];
        writeIndexIntradayCache(intradayKey, items);
      } catch { /* Fall back to daily data without blanking the chart. */ }
    }
    if (!items?.length) {
      items = !force ? readIndexKlineCache(dayKey) : null;
      if (!items?.length) {
        try {
          items = (await apiFetch<{ items: KlinePoint[] }>(
            `/api/market-data/stocks/${code}/kline?period=day`,
          )).items ?? [];
          writeIndexKlineCache(dayKey, items);
        } catch { /* Keep the last usable result during transient failures. */ }
      }
    }
    if (items?.length) {
      marketDataCache.indexPreviews[code] = { items, checkedAt: Date.now() };
      return items;
    }
    return peekIndexPreview(code) ?? [];
  })();
  pending.set(code, task);
  void task.finally(() => pending.delete(code));
  return task;
}
