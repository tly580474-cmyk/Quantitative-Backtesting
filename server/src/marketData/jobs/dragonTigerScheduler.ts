import { getChinaMarketSession } from './marketSession.js';
import { getOpenTradingDays, getTradeDateStatus } from '../repositories/calendarRepository.js';
import { finishCollectorRun, tryStartCollectorRun } from '../repositories/collectorRunRepository.js';
import { getMarketBillboard } from '../dragonTigerService.js';

interface DragonTigerSchedulerConfig {
  syncTime: string;
  recheckTime: string;
}

let intervalId: ReturnType<typeof setInterval> | null = null;
let running = false;
let config: DragonTigerSchedulerConfig | null = null;
let startupCatchupPending = true;

export function startDragonTigerScheduler(input: DragonTigerSchedulerConfig): void {
  if (intervalId) return;
  config = input;
  startupCatchupPending = true;
  void tick();
  intervalId = setInterval(() => void tick(), 60_000);
}

export function stopDragonTigerScheduler(): void {
  if (intervalId) clearInterval(intervalId);
  intervalId = null;
  config = null;
  startupCatchupPending = true;
}

export function isCollectorTimeDue(minuteOfDay: number, target: string): boolean {
  const match = target.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  return Boolean(match && minuteOfDay >= Number(match![1]) * 60 + Number(match![2]));
}

async function tick(): Promise<void> {
  if (running || !config) return;
  running = true;
  try {
    const session = getChinaMarketSession();
    if (startupCatchupPending) {
      startupCatchupPending = false;
      const recentDays = await getOpenTradingDays('SH', daysBefore(session.tradeDate, 14), session.tradeDate);
      const latestOpenDate = recentDays.at(-1);
      if (latestOpenDate) await collect(latestOpenDate, 'startup');
    }
    const status = await getTradeDateStatus('SH', session.tradeDate);
    if (status === false || (status == null && (session.weekday === 0 || session.weekday === 6))) return;
    for (const target of [config.syncTime, config.recheckTime]) {
      if (!isCollectorTimeDue(session.minuteOfDay, target)) continue;
      await collect(session.tradeDate, target);
    }
  } finally {
    running = false;
  }
}

async function collect(tradeDate: string, slot: string): Promise<void> {
  const runKey = `dragon_tiger:${tradeDate}:${slot}`;
  if (!await tryStartCollectorRun(runKey, 'dragon_tiger')) return;
  try {
    const snapshot = await getMarketBillboard({ date: tradeDate, force: true, dbOnline: true });
    await finishCollectorRun(runKey, 'succeeded', {
      details: { tradeDate: snapshot.tradeDate, records: snapshot.total, source: snapshot.source },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finishCollectorRun(runKey, 'failed', { errorMessage: message });
    console.error(`[dragonTigerScheduler] ${runKey} failed: ${message}`);
  }
}

function daysBefore(date: string, count: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() - count);
  return value.toISOString().slice(0, 10);
}
