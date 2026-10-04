import {
  expireStaleCollectorRuns,
  finishCollectorRun,
  tryStartCollectorRun,
  updateCollectorRunDetails,
} from '../repositories/collectorRunRepository.js';
import { getChinaMarketSession } from './marketSession.js';
import type { MarketOpinionDigestKind } from '../../services/marketOpinionAgent.js';
import type { MarketOpinionPushService } from '../../services/marketOpinionPushService.js';

let intervalId: ReturnType<typeof setInterval> | null = null;
let ticking = false;

export interface MarketOpinionPushSchedule {
  times: Record<MarketOpinionDigestKind, string>;
  graceMinutes: number;
}

export function startMarketOpinionPushScheduler(service: MarketOpinionPushService, schedule: MarketOpinionPushSchedule): void {
  if (intervalId) return;
  void tick(service, schedule);
  intervalId = setInterval(() => void tick(service, schedule), 30_000);
  intervalId.unref?.();
}

export function stopMarketOpinionPushScheduler(): void {
  if (intervalId) clearInterval(intervalId);
  intervalId = null;
}

export function dueDigestKinds(now: Date, schedule: MarketOpinionPushSchedule): MarketOpinionDigestKind[] {
  const session = getChinaMarketSession(now);
  return (Object.entries(schedule.times) as Array<[MarketOpinionDigestKind, string]>)
    .filter(([, time]) => {
      const due = parseMinute(time);
      return session.minuteOfDay >= due && session.minuteOfDay <= due + schedule.graceMinutes;
    })
    .map(([kind]) => kind);
}

async function tick(service: MarketOpinionPushService, schedule: MarketOpinionPushSchedule): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const now = new Date();
    await expireStaleCollectorRuns('market_opinion_push', 5);
    const session = getChinaMarketSession(now);
    const kinds = dueDigestKinds(now, schedule);
    if (!kinds.length || await service.dayMode(now) === 'skip') return;
    for (const kind of kinds) {
      const runKey = `market_opinion_push:${session.tradeDate}:${kind}`;
      if (!await tryStartCollectorRun(runKey, 'market_opinion_push', {
        maxAttempts: 3,
        retryDelayMinutes: 5,
      })) continue;
      try {
        const result = await service.send(kind, now, {
          onStage: async (stage) => updateCollectorRunDetails(runKey, {
            stage,
            stageAt: new Date().toISOString(),
            scheduledFor: schedule.times[kind],
          }),
        });
        await finishCollectorRun(runKey, 'succeeded', { details: { ...result } });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await finishCollectorRun(runKey, 'failed', { errorMessage: message });
        console.error(`[marketOpinionPushScheduler] ${runKey} failed: ${message}`);
      }
    }
  } catch (error) {
    console.error('[marketOpinionPushScheduler] tick failed:', error instanceof Error ? error.message : String(error));
  } finally {
    ticking = false;
  }
}

function parseMinute(value: string): number {
  const [hour, minute] = value.split(':').map(Number);
  return hour * 60 + minute;
}
