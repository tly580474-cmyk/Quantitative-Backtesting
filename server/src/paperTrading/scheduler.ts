import type mysql from 'mysql2/promise';
import {
  getChinaMarketSession,
  type ChinaMarketSession,
} from '../marketData/jobs/marketSession.js';
import {
  matchActivePaperOrders,
  refreshPaperPositionQuotes,
  settlePaperPositionsT1,
} from './service.js';
import { recordAllPaperEquitySnapshots } from './equitySnapshot.js';

export interface PaperTradingSchedulerOptions {
  pool: mysql.Pool;
  minuteDataRoot: string;
  intervalMs?: number;
  batchSize?: number;
}

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;
let lastSettlementDate = '';
let lastSnapshotDate = '';

export function shouldRunPaperTradingMatcher(session: ChinaMarketSession) {
  return session.isIntradayUpdateWindow;
}

/**
 * 盘后快照触发条件：交易日 15:05 以后（isDailyBarFinal）才允许记录当日权益快照。
 * 重启后若当日尚未生成快照，会在下一次 tick 自动补录，使用 ON DUPLICATE KEY UPDATE
 * 保证幂等。
 */
export function shouldRunEquitySnapshot(session: ChinaMarketSession) {
  return session.isDailyBarFinal;
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
      if (shouldRunPaperTradingMatcher(session)) {
        const valuation = await refreshPaperPositionQuotes(
          options.pool,
          options.minuteDataRoot,
        );
        if (valuation.failures.length > 0) {
          console.warn(
            `[PaperTrading] Position quotes updated=${valuation.updated}/${valuation.scanned} failures=${valuation.failures.length}`,
          );
        }
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
      }
      if (shouldRunEquitySnapshot(session) && lastSnapshotDate !== session.tradeDate) {
        await refreshPaperPositionQuotes(options.pool, options.minuteDataRoot);
        const snapshots = await recordAllPaperEquitySnapshots(
          options.pool,
          session.tradeDate,
        );
        lastSnapshotDate = session.tradeDate;
        if (snapshots.length > 0) {
          console.log(
            `[PaperTrading] Equity snapshots recorded for ${snapshots.length} account(s) on ${session.tradeDate}`,
          );
        }
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
  lastSnapshotDate = '';
}
