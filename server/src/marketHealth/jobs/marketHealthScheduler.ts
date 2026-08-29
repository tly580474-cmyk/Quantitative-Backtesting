import { finishCollectorRun, tryStartCollectorRun } from '../../marketData/repositories/collectorRunRepository.js';
import { getChinaMarketSession } from '../../marketData/jobs/marketSession.js';
import { refreshNominalEarningsCycle } from './nominalCycleJob.js';

export interface MarketHealthSchedulerConfig {
  enabled: boolean;
  macroCheckTime: string;
  pythonExecutable?: string;
}

let intervalId: ReturnType<typeof setInterval> | null = null;
let running = false;

export function startMarketHealthScheduler(config: MarketHealthSchedulerConfig): void {
  if (intervalId || !config.enabled) return;
  void tick(config);
  intervalId = setInterval(() => void tick(config), 60_000);
  intervalId.unref?.();
}

export function stopMarketHealthScheduler(): void {
  if (intervalId) clearInterval(intervalId);
  intervalId = null;
  running = false;
}

export function isNaturalDayTaskDue(currentMinute: number, target: string): boolean {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(target);
  return Boolean(match && currentMinute >= Number(match![1]) * 60 + Number(match![2]));
}

async function tick(config: MarketHealthSchedulerConfig): Promise<void> {
  if (running) return;
  const session = getChinaMarketSession();
  if (!isNaturalDayTaskDue(session.minuteOfDay, config.macroCheckTime)) return;
  const runKey = `market_health_nec:${session.tradeDate}`;
  if (!await tryStartCollectorRun(runKey, 'market_health_nec', { retryDelayMinutes: 30 })) return;
  running = true;
  try {
    const result = await refreshNominalEarningsCycle(config.pythonExecutable);
    await finishCollectorRun(runKey, 'succeeded', { details: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finishCollectorRun(runKey, 'failed', { errorMessage: message });
    console.error(`[marketHealthScheduler] ${runKey} failed: ${message}`);
  } finally {
    running = false;
  }
}
