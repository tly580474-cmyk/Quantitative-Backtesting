import { getTradeDateStatus } from './repositories/calendarRepository.js';

export type WatchlistSessionPhase = 'trading' | 'lunch' | 'closed' | 'unknown';

export interface WatchlistSession {
  serverTime: string;
  phase: WatchlistSessionPhase;
  /** Current calendar date in Asia/Shanghai, even when the date is closed. */
  sessionDate: string;
  /** Server clock deadline for the next session check or quote refresh. */
  nextCheckAt: string;
  /** Current open date after the close, used to de-duplicate final refreshes. */
  closeRefreshKey: string | null;
}

export type TradeDateStatusReader = (market: string, date: string) => Promise<boolean | null>;
/** Optional live evidence used only when the persisted row is missing. */
export type TradingDateEvidenceReader = (date: string) => Promise<boolean | null>;

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const MORNING_OPEN = 9 * 60 + 30;
const MORNING_CLOSE = 11 * 60 + 30;
const AFTERNOON_OPEN = 13 * 60;
const AFTERNOON_CLOSE = 15 * 60;
const FINAL_REFRESH_AT = 15 * 60 + 5;
const UNKNOWN_RECHECK_MS = 60_000;

/**
 * Build the mobile watchlist clock from the server clock and the persisted
 * Shanghai calendar. A missing or failed calendar lookup is deliberately
 * treated as unknown so a weekday never starts live polling by assumption.
 */
export async function getWatchlistSession(
  now = new Date(),
  readTradeDateStatus: TradeDateStatusReader = getTradeDateStatus,
  readTradingDateEvidence?: TradingDateEvidenceReader,
): Promise<WatchlistSession> {
  const shanghai = new Date(now.getTime() + SHANGHAI_OFFSET_MS);
  const sessionDate = shanghai.toISOString().slice(0, 10);
  let calendarStatus: boolean | null = null;
  try {
    calendarStatus = await readTradeDateStatus('SH', sessionDate);
  } catch {
    // Fail closed when the database is unavailable. The client will only
    // retry this lightweight endpoint and will retain the last quote values.
  }

  const minuteOfDay = shanghai.getUTCHours() * 60 + shanghai.getUTCMinutes();
  const weekday = shanghai.getUTCDay();
  const weekdayIsOpen = weekday >= 1 && weekday <= 5;
  let effectiveCalendarStatus = calendarStatus;
  // A missing calendar row is not evidence of an open weekday. During a
  // current session, callers may provide a separately validated live
  // index timestamp (for example, today's quote date) as evidence. Outside a
  // session we remain closed. Keep the evidence through lunch and after close
  // so a missing row cannot turn the morning snapshot into yesterday's close.
  if (effectiveCalendarStatus == null && weekdayIsOpen && minuteOfDay >= MORNING_OPEN && readTradingDateEvidence) {
    try {
      effectiveCalendarStatus = await readTradingDateEvidence(sessionDate);
    } catch {
      effectiveCalendarStatus = null;
    }
  }
  const phase = classifyPhase(effectiveCalendarStatus, weekdayIsOpen, minuteOfDay);
  const serverTime = now.toISOString();
  const nextCheckAt = nextCheck(now, shanghai, effectiveCalendarStatus, phase, minuteOfDay);
  const closeRefreshKey = effectiveCalendarStatus === true
    && minuteOfDay >= AFTERNOON_CLOSE
    ? `${sessionDate}:${minuteOfDay < FINAL_REFRESH_AT ? 'close' : 'final'}`
    : null;

  return { serverTime, phase, sessionDate, nextCheckAt, closeRefreshKey };
}

function classifyPhase(
  calendarStatus: boolean | null,
  weekdayIsOpen: boolean,
  minuteOfDay: number,
): WatchlistSessionPhase {
  // Weekends and times outside the two exchange windows are closed even if
  // the calendar row is missing. This lets the client use the last persisted
  // close without treating a weekday convention as an opening signal.
  if (!weekdayIsOpen || !isTradingMinute(minuteOfDay)) {
    if (calendarStatus === true && minuteOfDay >= MORNING_CLOSE && minuteOfDay < AFTERNOON_OPEN) return 'lunch';
    return 'closed';
  }
  if (calendarStatus == null) return 'unknown';
  if (!calendarStatus) return 'closed';
  if (minuteOfDay >= MORNING_OPEN && minuteOfDay < MORNING_CLOSE) return 'trading';
  if (minuteOfDay >= AFTERNOON_OPEN && minuteOfDay < AFTERNOON_CLOSE) return 'trading';
  return 'closed';
}

function isTradingMinute(minuteOfDay: number): boolean {
  return (minuteOfDay >= MORNING_OPEN && minuteOfDay < MORNING_CLOSE)
    || (minuteOfDay >= AFTERNOON_OPEN && minuteOfDay < AFTERNOON_CLOSE);
}

function nextCheck(
  now: Date,
  shanghai: Date,
  calendarStatus: boolean | null,
  phase: WatchlistSessionPhase,
  minuteOfDay: number,
): string {
  if (phase === 'unknown') return new Date(now.getTime() + UNKNOWN_RECHECK_MS).toISOString();
  if (phase === 'trading') {
    // The client owns the five-second quote timer while the market is open.
    // The session endpoint is only revisited at the next phase boundary.
    const boundary = minuteOfDay < MORNING_CLOSE ? MORNING_CLOSE : AFTERNOON_CLOSE;
    return atShanghai(shanghai, boundary).toISOString();
  }
  if (phase === 'lunch') return atShanghai(shanghai, AFTERNOON_OPEN).toISOString();
  if (calendarStatus == null && shanghai.getUTCDay() >= 1 && shanghai.getUTCDay() <= 5
      && minuteOfDay >= MORNING_CLOSE && minuteOfDay < AFTERNOON_OPEN) {
    return atShanghai(shanghai, AFTERNOON_OPEN).toISOString();
  }
  if (calendarStatus === true && minuteOfDay >= AFTERNOON_CLOSE && minuteOfDay < FINAL_REFRESH_AT) {
    return atShanghai(shanghai, FINAL_REFRESH_AT).toISOString();
  }
  if (minuteOfDay < MORNING_OPEN) {
    return atShanghai(shanghai, MORNING_OPEN).toISOString();
  }
  // For closed calendar dates, check once at the next Shanghai open boundary.
  // This handles weekends and multi-day holidays without guessing future
  // calendar rows or polling quotes while the market is closed.
  return atShanghai(shanghai, MORNING_OPEN, 1).toISOString();
}

function atShanghai(shanghai: Date, minuteOfDay: number, dayOffset = 0): Date {
  const year = shanghai.getUTCFullYear();
  const month = shanghai.getUTCMonth();
  const day = shanghai.getUTCDate() + dayOffset;
  return new Date(Date.UTC(year, month, day, Math.floor(minuteOfDay / 60), minuteOfDay % 60) - SHANGHAI_OFFSET_MS);
}
