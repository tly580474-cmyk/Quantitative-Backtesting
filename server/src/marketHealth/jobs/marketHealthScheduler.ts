import { finishCollectorRun, tryStartCollectorRun } from '../../marketData/repositories/collectorRunRepository.js';
import { getChinaMarketSession } from '../../marketData/jobs/marketSession.js';
import { refreshNominalEarningsCycle } from './nominalCycleJob.js';
import { refreshFundamentalValuation } from './fundamentalValuationJob.js';

export interface MarketHealthSchedulerConfig {
  enabled: boolean;
  macroCheckTime: string;
  dailyMaterializationTime: string;
  snapshotRoot: string;
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
  running = true;
  try {
    if (isNaturalDayTaskDue(session.minuteOfDay, config.macroCheckTime)) {
      await runCollectorTask(
        `market_health_nec:${session.tradeDate}`,
        'market_health_nec',
        () => refreshNominalEarningsCycle(config.pythonExecutable),
      );
    }
    if (isNaturalDayTaskDue(session.minuteOfDay, config.dailyMaterializationTime)) {
      await runCollectorTask(
        `market_health_fhi_vpi:${session.tradeDate}`,
        'market_health_fhi_vpi',
        () => refreshFundamentalValuation(config.snapshotRoot),
      );
    }
  } finally {
    running = false;
  }
}

async function runCollectorTask(
  runKey: string,
  collectorKey: string,
  task: () => Promise<object>,
): Promise<void> {
  if (!await tryStartCollectorRun(runKey, collectorKey, { retryDelayMinutes: 30 })) return;
  try {
    const result = await task();
    await finishCollectorRun(runKey, 'succeeded', { details: { ...result } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finishCollectorRun(runKey, 'failed', { errorMessage: message });
    console.error(`[marketHealthScheduler] ${runKey} failed: ${message}`);
  }
}
