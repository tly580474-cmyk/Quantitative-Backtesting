import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/api/client';
import { marketDataCache } from './marketDataCache';
import type { StockQuote } from './types';
import type { WatchlistQuoteMode } from './useWatchlistRefresh';

/** The compact list only needs quotes, never K-lines, reports or score data. */
export function useWatchlistQuotes(codes: string[]) {
  const key = [...new Set(codes)].sort().join(',');
  const [quotes, setQuotes] = useState<Record<string, StockQuote>>(() => ({ ...marketDataCache.quotes }));
  const [indexQuotes, setIndexQuotes] = useState<StockQuote[]>(() => marketDataCache.indexQuotes ?? []);
  const [loading, setLoading] = useState(false);
  const [failedCodes, setFailedCodes] = useState<string[]>([]);
  const [indexFailed, setIndexFailed] = useState(false);
  const refreshRef = useRef<(mode: WatchlistQuoteMode) => Promise<void>>(async () => {});

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    let activeController: AbortController | null = null;
    const requested = key ? key.split(',') : [];
    const refresh = async (mode: WatchlistQuoteMode) => {
      if (inFlight || cancelled) return;
      inFlight = true;
      const controller = new AbortController();
      activeController = controller;
      setLoading(true);
      const failed = new Set<string>();
      const snapshot = mode === 'close' ? '&snapshot=close' : '';
      const timeoutMs = mode === 'close' ? 30_000 : 4_000;
      const indices = apiFetch<{ items: StockQuote[] }>(
        `/api/market-data/indices/quotes${mode === 'close' ? '?snapshot=close' : ''}`,
        { signal: controller.signal, timeoutMs },
      )
        .then(({ items }) => {
          if (cancelled || controller.signal.aborted) return;
          const received = new Set(items.map(item => `${item.market}:${item.code}`));
          const missingPrevious = (marketDataCache.indexQuotes ?? [])
            .some(item => !received.has(`${item.market}:${item.code}`));
          // A partial provider response must not erase the previous values.
          setIndexQuotes(current => {
            const merged = new Map(current.map(item => [`${item.market}:${item.code}`, item]));
            items.forEach(item => merged.set(`${item.market}:${item.code}`, item));
            const next = [...merged.values()];
            marketDataCache.indexQuotes = next;
            return next;
          });
          setIndexFailed(!items.length || missingPrevious);
        }).catch(() => { if (!cancelled) setIndexFailed(true); });
      try {
        // Four workers each take the next symbol as soon as their previous
        // request finishes. A slow symbol therefore occupies one worker
        // instead of blocking a whole later batch.
        let nextIndex = 0;
        const worker = async () => {
          while (!cancelled && !controller.signal.aborted) {
            const index = nextIndex++;
            const code = requested[index];
            if (!code) return;
            try {
              const value = await apiFetch<StockQuote>(
                `/api/market-data/stocks/${code}/quote?profile=false${snapshot}`,
                { signal: controller.signal, timeoutMs },
              );
              if (cancelled || controller.signal.aborted) return;
              marketDataCache.quotes[code] = value;
              setQuotes(current => ({ ...current, [code]: value }));
            } catch {
              if (cancelled || controller.signal.aborted) return;
              failed.add(code);
            }
          }
        };
        await Promise.all(Array.from({ length: Math.min(4, requested.length) }, () => worker()));
        if (!cancelled && !controller.signal.aborted) {
          setFailedCodes(requested.filter(code => failed.has(code)));
        }
      } finally {
        await indices;
        inFlight = false;
        if (activeController === controller) activeController = null;
        if (!cancelled) setLoading(false);
      }
    };
    setLoading(false);
    setFailedCodes([]);
    refreshRef.current = refresh;
    return () => {
      cancelled = true;
      activeController?.abort();
      refreshRef.current = async () => {};
    };
  }, [key]);

  return { key, quotes, indexQuotes, loading, failedCodes, indexFailed,
    refresh: (mode: WatchlistQuoteMode) => refreshRef.current(mode) };
}
