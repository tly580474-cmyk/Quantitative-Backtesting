import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/api/client';

export interface WatchlistSession {
  serverTime: string;
  sessionDate: string;
  phase: 'trading' | 'lunch' | 'closed' | 'unknown';
  nextCheckAt: string;
  closeRefreshKey: string | null;
}

export type WatchlistQuoteMode = 'live' | 'close';

/** One clock drives both the securities and index rail. Market time comes from
 * the server, so phone time zones and exchange holidays cannot start polling. */
export function useWatchlistRefresh(
  refreshQuotes: (mode: WatchlistQuoteMode) => Promise<void>,
  listKey: string,
) {
  const [phase, setPhase] = useState<WatchlistSession['phase']>('unknown');
  const refreshQuotesRef = useRef(refreshQuotes);
  refreshQuotesRef.current = refreshQuotes;
  const refreshRef = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    let timer: number | undefined;
    let session: WatchlistSession | undefined;
    let checkAt = 0;

    const run = async (force = false) => {
      if (cancelled || inFlight || document.hidden) return;
      window.clearTimeout(timer);
      inFlight = true;
      const startedAt = Date.now();
      let refresh = force;
      try {
        if (!session || Date.now() >= checkAt || force) {
          const previous = session;
          try {
            const next = await apiFetch<WatchlistSession>('/api/market-data/watchlist-session');
            if (cancelled) return;
            const remaining = Date.parse(next.nextCheckAt) - Date.parse(next.serverTime);
            if (!Number.isFinite(remaining) || remaining <= 0) throw new Error('Invalid session deadline');
            session = next;
            // Subtract request time instead of trusting the device's wall clock.
            checkAt = startedAt + remaining;
            setPhase(next.phase);
            refresh ||= !previous || previous.phase !== next.phase
              || previous.sessionDate !== next.sessionDate
              || previous.closeRefreshKey !== next.closeRefreshKey;
          } catch {
            // Fail closed: retain displayed quotes and retry only the small
            // session request. Never guess that a weekday is a trading day.
            session = undefined;
            checkAt = Date.now() + 60_000;
            setPhase('unknown');
            return;
          }
        }
        if (session?.phase !== 'unknown' && (refresh || session?.phase === 'trading')) {
          await refreshQuotesRef.current(session?.phase === 'closed' ? 'close' : 'live');
        }
      } finally {
        inFlight = false;
        if (!cancelled && !document.hidden) {
          const untilCheck = Math.max(0, checkAt - Date.now());
          const delay = session?.phase === 'trading'
            // Skip missed slots after slow requests; never immediately hammer
            // the endpoint when a round took longer than five seconds.
            ? Math.min(5_000 - ((Date.now() - startedAt) % 5_000), untilCheck)
            : untilCheck;
          timer = window.setTimeout(() => { void run(); }, Math.max(50, delay));
        }
      }
    };
    const onVisibilityChange = () => {
      window.clearTimeout(timer);
      if (!document.hidden) void run(true);
    };
    refreshRef.current = () => run(true);
    document.addEventListener('visibilitychange', onVisibilityChange);
    void run(true);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      refreshRef.current = async () => {};
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [listKey]);

  return { phase, refresh: () => refreshRef.current() };
}
