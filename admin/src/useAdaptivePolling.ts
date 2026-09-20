import { useEffect, useRef } from 'react';

/** No overlapping requests; hidden tabs pause, failures back off to at most 5 minutes. */
export function useAdaptivePolling(callback: () => Promise<void>, delay: number, immediate = true, enabled = true) {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;
  const busy = useRef(false);
  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let failures = 0;
    const schedule = () => {
      clearTimeout(timer);
      if (!stopped && document.visibilityState !== 'hidden') {
        timer = setTimeout(run, Math.min(delay * 2 ** failures, 300_000));
      }
    };
    const run = async () => {
      if (stopped || document.visibilityState === 'hidden') return;
      if (busy.current) { schedule(); return; }
      busy.current = true;
      try { await callbackRef.current(); failures = 0; }
      catch { failures = Math.min(failures + 1, 5); }
      finally { busy.current = false; schedule(); }
    };
    const visibility = () => {
      clearTimeout(timer);
      if (document.visibilityState !== 'hidden') void run();
    };
    document.addEventListener('visibilitychange', visibility);
    if (immediate) void run();
    else schedule();
    return () => { stopped = true; clearTimeout(timer); document.removeEventListener('visibilitychange', visibility); };
  }, [delay, immediate, enabled]);
}
