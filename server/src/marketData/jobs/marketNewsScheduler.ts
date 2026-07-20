import { getChinaMarketSession } from './marketSession.js';
import { refreshMarketNews } from '../marketNewsService.js';
import { deleteMarketNewsBefore } from '../repositories/marketNewsRepository.js';
import { expireStaleCollectorRuns, finishCollectorRun, tryStartCollectorRun } from '../repositories/collectorRunRepository.js';

let intervalId: ReturnType<typeof setInterval> | null = null;
let running = false;
let refreshIntervalMinutes = 3;
let retentionDays = 30;

export function startMarketNewsScheduler(options: { refreshIntervalMinutes: number; retentionDays: number }): void {
  if (intervalId) return;
  refreshIntervalMinutes = Math.max(1, Math.min(60, Math.floor(options.refreshIntervalMinutes)));
  retentionDays = Math.max(1, Math.min(365, Math.floor(options.retentionDays)));
  void tick();
  intervalId = setInterval(() => void tick(), 60_000);
}

export function stopMarketNewsScheduler(): void {
  if (intervalId) clearInterval(intervalId);
  intervalId = null;
}

export function newsSlotKey(now: Date, intervalMinutes: number): string {
  const session = getChinaMarketSession(now);
  const slot = Math.floor(session.minuteOfDay / Math.max(1, intervalMinutes)) * Math.max(1, intervalMinutes);
  return `${session.tradeDate}:${String(Math.floor(slot / 60)).padStart(2, '0')}${String(slot % 60).padStart(2, '0')}`;
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const now = new Date();
    await expireStaleCollectorRuns('market_news', 2);
    const runKey = `market_news:${newsSlotKey(now, refreshIntervalMinutes)}`;
    if (await tryStartCollectorRun(runKey, 'market_news')) {
      try {
        const snapshot = await withTimeout(refreshMarketNews(true, 50), 60_000, '新闻采集超过 60 秒');
        await finishCollectorRun(runKey, 'succeeded', { details: { records: snapshot.total, sources: snapshot.sources } });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await finishCollectorRun(runKey, 'failed', { errorMessage: message });
        console.error(`[marketNewsScheduler] ${runKey} failed: ${message}`);
      }
    }
    const session = getChinaMarketSession(now);
    if (session.minuteOfDay >= 3 * 60) await cleanup(session.tradeDate);
  } finally {
    running = false;
  }
}

export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), Math.max(1, timeoutMs));
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function cleanup(tradeDate: string): Promise<void> {
  const runKey = `market_news_cleanup:${tradeDate}`;
  if (!await tryStartCollectorRun(runKey, 'market_news_cleanup')) return;
  try {
    const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
    let removed = 0;
    for (;;) {
      const count = await deleteMarketNewsBefore(cutoff, 5_000);
      removed += count;
      if (count < 5_000) break;
    }
    await finishCollectorRun(runKey, 'succeeded', { details: { cutoff, removed } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finishCollectorRun(runKey, 'failed', { errorMessage: message });
  }
}
