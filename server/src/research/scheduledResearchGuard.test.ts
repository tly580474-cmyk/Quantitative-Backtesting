import { describe, expect, it } from 'vitest';
import { decideScheduledResearchUpdate, shanghaiDate } from './scheduledResearchGuard.js';

describe('scheduled research update guard', () => {
  it('skips weekends before consulting database evidence', () => {
    expect(decideScheduledResearchUpdate({
      date: '2026-07-18',
      calendarStatuses: [true],
      latestDailyBarDate: '2026-07-18',
    })).toMatchObject({ shouldRun: false, reason: 'weekend' });
  });

  it('skips an exchange holiday recorded by the trading calendar', () => {
    expect(decideScheduledResearchUpdate({
      date: '2026-10-01',
      calendarStatuses: [false, false, false],
      latestDailyBarDate: '2026-09-30',
    })).toMatchObject({ shouldRun: false, reason: 'exchange-holiday' });
  });

  it('runs when any configured Chinese market is open', () => {
    expect(decideScheduledResearchUpdate({
      date: '2026-07-17',
      calendarStatuses: [false, true],
      latestDailyBarDate: '2026-07-16',
    })).toMatchObject({ shouldRun: true, evidence: 'trading-calendar' });
  });

  it('uses current daily bars only when the calendar row is missing', () => {
    expect(decideScheduledResearchUpdate({
      date: '2026-07-17',
      calendarStatuses: [],
      latestDailyBarDate: '2026-07-17',
    })).toMatchObject({ shouldRun: true, evidence: 'daily-bars' });
  });

  it('fails closed when a weekday is absent from both calendar and daily bars', () => {
    expect(decideScheduledResearchUpdate({
      date: '2026-10-02',
      calendarStatuses: [],
      latestDailyBarDate: '2026-09-30',
    })).toMatchObject({ shouldRun: false, reason: 'calendar-missing' });
  });

  it('formats the scheduling date in Asia/Shanghai', () => {
    expect(shanghaiDate(new Date('2026-07-17T16:30:00.000Z'))).toBe('2026-07-18');
  });
});
