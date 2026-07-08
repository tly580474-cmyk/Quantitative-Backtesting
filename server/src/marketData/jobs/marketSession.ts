export type ChinaMarketPhase =
  | 'closed'
  | 'pre_open'
  | 'morning'
  | 'lunch'
  | 'afternoon'
  | 'settling'
  | 'final';

export interface ChinaMarketSession {
  tradeDate: string;
  minuteOfDay: number;
  weekday: number;
  phase: ChinaMarketPhase;
  isIntradayUpdateWindow: boolean;
  isDailyBarFinal: boolean;
}

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const MORNING_OPEN = 9 * 60 + 30;
const MORNING_CLOSE = 11 * 60 + 30;
const AFTERNOON_OPEN = 13 * 60;
const AFTERNOON_CLOSE = 15 * 60;
const FINALIZE_AT = 15 * 60 + 5;

export function getChinaMarketSession(now = new Date()): ChinaMarketSession {
  const shanghai = new Date(now.getTime() + SHANGHAI_OFFSET_MS);
  const weekday = shanghai.getUTCDay();
  const minuteOfDay = shanghai.getUTCHours() * 60 + shanghai.getUTCMinutes();
  const tradeDate = shanghai.toISOString().slice(0, 10);
  const isWeekday = weekday >= 1 && weekday <= 5;

  let phase: ChinaMarketPhase = 'closed';
  if (isWeekday) {
    if (minuteOfDay < MORNING_OPEN) phase = 'pre_open';
    else if (minuteOfDay <= MORNING_CLOSE) phase = 'morning';
    else if (minuteOfDay < AFTERNOON_OPEN) phase = 'lunch';
    else if (minuteOfDay <= AFTERNOON_CLOSE) phase = 'afternoon';
    else if (minuteOfDay < FINALIZE_AT) phase = 'settling';
    else phase = 'final';
  }

  return {
    tradeDate,
    minuteOfDay,
    weekday,
    phase,
    isIntradayUpdateWindow: phase === 'morning' || phase === 'afternoon',
    isDailyBarFinal: phase === 'final',
  };
}

export function shouldRunIntradaySlot(
  session: ChinaMarketSession,
  intervalMinutes: number,
): boolean {
  if (!session.isIntradayUpdateWindow) return false;
  const interval = Math.max(1, Math.floor(intervalMinutes));
  const sessionStart = session.phase === 'morning' ? MORNING_OPEN : AFTERNOON_OPEN;
  return (session.minuteOfDay - sessionStart) % interval === 0;
}

export function assertStockDailyUpdateAfterClose(
  session = getChinaMarketSession(),
): void {
  if (!session.isDailyBarFinal) {
    throw new Error(
      `个股行情增量更新仅允许盘后执行，当前 ${session.tradeDate} ` +
      `${formatMinuteOfDay(session.minuteOfDay)} 仍处于 ${session.phase} 阶段`,
    );
  }
}

function formatMinuteOfDay(minuteOfDay: number): string {
  return `${String(Math.floor(minuteOfDay / 60)).padStart(2, '0')}:${
    String(minuteOfDay % 60).padStart(2, '0')
  }`;
}
