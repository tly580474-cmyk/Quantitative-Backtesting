import type mysql from 'mysql2/promise';
import {
  getChinaMarketSession,
  type ChinaMarketSession,
} from '../marketData/jobs/marketSession.js';
import {
  matchActivePaperOrders,
  settlePaperPositionsT1,
} from './service.js';

export interface PaperTradingSchedulerOptions {
  pool: mysql.Pool;
  minuteDataRoot: string;
  intervalMs?: number;
  batchSize?: number;
}

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;
let lastSettlementDate = '';

export function shouldRunPaperTradingMatcher(session: ChinaMarketSession) {
  return session.isIntradayUpdateWindow;
}

export function startPaperTradingScheduler(options: PaperTradingSchedulerOptions) {
  stopPaperTradingScheduler();
  const intervalMs = Math.max(5_000, options.intervalMs ?? 30_000);
  const batchSize = Math.max(1, Math.min(500, options.batchSize ?? 100));

  const tick = async () => {
    if (running) return;
    const session = getChinaMarketSession();
    running = true;
    try {
      if (lastSettlementDate !== session.tradeDate) {
        await settlePaperPositionsT1(options.pool, session.tradeDate);
        lastSettlementDate = session.tradeDate;
      }
      if (!shouldRunPaperTradingMatcher(session)) return;
      const result = await matchActivePaperOrders(
        options.pool,
        options.minuteDataRoot,
        batchSize,
      );
      if (result.matched > 0 || result.failures.length > 0) {
        console.log(
          `[PaperTrading] Matcher scanned=${result.scanned} matched=${result.matched} failures=${result.failures.length}`,
        );
      }
    } catch (error) {
      console.error('[PaperTrading] Scheduler tick failed:', error);
    } finally {
      running = false;
    }
  };

  timer = setInterval(() => {
    void tick();
  }, intervalMs);
  timer.unref?.();
  void tick();
  console.log(`[PaperTrading] Scheduler started, interval=${intervalMs}ms batch=${batchSize}`);
}

export function stopPaperTradingScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
  running = false;
  lastSettlementDate = '';
}
