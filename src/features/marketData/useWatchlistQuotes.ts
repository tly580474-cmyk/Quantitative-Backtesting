import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/api/client';
import { marketDataCache } from './marketDataCache';
import type { StockQuote } from './types';

/** The compact list only needs quotes, never K-lines, reports or score data. */
export function useWatchlistQuotes(codes: string[]) {
  const key = [...new Set(codes)].sort().join(',');
  const [quotes, setQuotes] = useState<Record<string, StockQuote>>(() => ({ ...marketDataCache.quotes }));
  const [loading, setLoading] = useState(false);
  const [failedCodes, setFailedCodes] = useState<string[]>([]);
  const refreshRef = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    const requested = key ? key.split(',') : [];
    const refresh = async () => {
      if (inFlight || cancelled || !requested.length) return;
      inFlight = true;
      setLoading(true);
      const failed: string[] = [];
      try {
        // Bound concurrency and publish each batch, so one slow symbol cannot
        // block every row. Preserve the last quote when one request fails.
        for (let index = 0; index < requested.length && !cancelled; index += 4) {
          const batch = requested.slice(index, index + 4);
          const results = await Promise.allSettled(batch.map(code =>
            apiFetch<StockQuote>(`/api/market-data/stocks/${code}/quote`)));
          if (cancelled) return;
          const next: Record<string, StockQuote> = {};
          results.forEach((result, offset) => {
            const code = batch[offset];
            if (result.status === 'fulfilled') {
              next[code] = result.value;
              marketDataCache.quotes[code] = result.value;
            } else failed.push(code);
          });
          setQuotes(current => ({ ...current, ...next }));
        }
        if (!cancelled) setFailedCodes(failed);
      } finally {
        inFlight = false;
        if (!cancelled) setLoading(false);
      }
    };
    setLoading(false);
    setFailedCodes([]);
    refreshRef.current = refresh;
    void refresh();
    const timer = window.setInterval(() => {
      if (!document.hidden) void refresh();
    }, 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      refreshRef.current = async () => {};
    };
  }, [key]);

  return { quotes, loading, failedCodes, refresh: () => refreshRef.current() };
}
