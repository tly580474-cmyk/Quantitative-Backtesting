export interface ScheduledResearchGuardInput {
  date: string;
  calendarStatuses: boolean[];
  latestDailyBarDate: string | null;
}

export interface ScheduledResearchGuardDecision {
  shouldRun: boolean;
  date: string;
  reason: 'trading-day' | 'weekend' | 'exchange-holiday' | 'calendar-missing';
  evidence: 'trading-calendar' | 'daily-bars' | 'calendar';
}

export function decideScheduledResearchUpdate(
  input: ScheduledResearchGuardInput,
): ScheduledResearchGuardDecision {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) {
    throw new Error(`无效日期：${input.date}`);
  }
  if (isWeekend(input.date)) {
    return {
      shouldRun: false,
      date: input.date,
      reason: 'weekend',
      evidence: 'calendar',
    };
  }
  if (input.calendarStatuses.length > 0) {
    const shouldRun = input.calendarStatuses.some(Boolean);
    return {
      shouldRun,
      date: input.date,
      reason: shouldRun ? 'trading-day' : 'exchange-holiday',
      evidence: 'trading-calendar',
    };
  }
  if (input.latestDailyBarDate === input.date) {
    return {
      shouldRun: true,
      date: input.date,
      reason: 'trading-day',
      evidence: 'daily-bars',
    };
  }
  return {
    shouldRun: false,
    date: input.date,
    reason: 'calendar-missing',
    evidence: 'calendar',
  };
}

export function shanghaiDate(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

function isWeekend(date: string): boolean {
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  return weekday === 0 || weekday === 6;
}
