import type { TencentMarketDataProvider } from '../providers/tencentProvider.js';
import { updateIndexDatasets } from './indexDatasetUpdater.js';

export interface IndexDatasetSchedulerConfig {
  enabled: boolean;
  cnUpdateTime: string;
  usUpdateTime: string;
}

interface SchedulerState {
  intervalId: ReturnType<typeof setInterval> | null;
  running: boolean;
  activeKeys: Set<string>;
  completedKeys: Set<string>;
}

const state: SchedulerState = {
  intervalId: null,
  running: false,
  activeKeys: new Set(),
  completedKeys: new Set(),
};

export function startIndexDatasetScheduler(
  config: IndexDatasetSchedulerConfig,
  provider: TencentMarketDataProvider,
): void {
  if (state.intervalId) {
    console.warn('[indexDatasetScheduler] Already running.');
    return;
  }
  if (!config.enabled) return;

  state.running = true;
  state.intervalId = setInterval(() => {
    void tick(config, provider).catch((error) => {
      console.error('[indexDatasetScheduler] Tick failed:', error);
    });
  }, 60_000);

  // Run one lightweight tick on startup so a service restart after the target
  // minute can still catch a configured retry window.
  void tick(config, provider).catch((error) => {
    console.error('[indexDatasetScheduler] Startup tick failed:', error);
  });

  console.log(
    `[indexDatasetScheduler] Started. CN at ${config.cnUpdateTime}, US at ${config.usUpdateTime} (Asia/Shanghai).`,
  );
}

export function stopIndexDatasetScheduler(): void {
  if (state.intervalId) {
    clearInterval(state.intervalId);
    state.intervalId = null;
  }
  state.activeKeys.clear();
  state.completedKeys.clear();
  state.running = false;
  console.log('[indexDatasetScheduler] Stopped.');
}

export function isIndexDatasetSchedulerRunning(): boolean {
  return state.running;
}

async function tick(
  config: IndexDatasetSchedulerConfig,
  provider: TencentMarketDataProvider,
): Promise<void> {
  const now = new Date();
  const shanghaiDate = dateInTimezone(now, 'Asia/Shanghai');
  const shanghaiTime = timeInTimezone(now, 'Asia/Shanghai');

  const triggers = [
    { group: 'cn-index' as const, time: config.cnUpdateTime },
    { group: 'us-index' as const, time: config.usUpdateTime },
  ];

  for (const trigger of triggers) {
    if (!isScheduledTimeDue(shanghaiTime, trigger.time)) continue;

    const activeKey = `${trigger.group}:${shanghaiDate}`;
    if (state.activeKeys.has(activeKey) || state.completedKeys.has(activeKey)) continue;
    state.activeKeys.add(activeKey);

    void updateIndexDatasets(trigger.group, provider, now)
      .then((result) => {
        console.log(
          `[indexDatasetScheduler] ${trigger.group} ${result.targetDate}: ` +
          `scanned=${result.scanned}, updated=${result.updated}, skipped=${result.skipped}, failed=${result.failed}`,
        );
        if (result.failed === 0) {
          state.completedKeys.add(activeKey);
        }
      })
      .catch((error) => {
        console.error(`[indexDatasetScheduler] ${trigger.group} update failed:`, error);
      })
      .finally(() => {
        state.activeKeys.delete(activeKey);
      });
  }
}

export function isScheduledTimeDue(current: string, scheduled: string): boolean {
  if (!isValidTime(current) || !isValidTime(scheduled)) return false;
  return current >= scheduled;
}

function isValidTime(value: string): boolean {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  return !!match && Number(match[1]) <= 23 && Number(match[2]) <= 59;
}

function dateInTimezone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  return `${year}-${month}-${day}`;
}

function timeInTimezone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const hour = parts.find((part) => part.type === 'hour')?.value;
  const minute = parts.find((part) => part.type === 'minute')?.value;
  return `${hour}:${minute}`;
}
