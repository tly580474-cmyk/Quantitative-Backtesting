import { describe, expect, it } from 'vitest';
import { getWatchlistSession } from './watchlistSession.js';

function utc(value: string): Date {
  return new Date(`${value}Z`);
}

const openCalendar = async () => true;
const holidayCalendar = async () => false;
const missingCalendar = async () => null;

describe('mobile watchlist session contract', () => {
  it('uses the persisted calendar before starting the five-second trading clock', async () => {
    const session = await getWatchlistSession(utc('2026-08-31T01:30:00'), openCalendar);
    expect(session).toMatchObject({
      serverTime: '2026-08-31T01:30:00.000Z',
      sessionDate: '2026-08-31',
      phase: 'trading',
      closeRefreshKey: null,
      nextCheckAt: '2026-08-31T03:30:00.000Z',
    });
  });

  it('pauses during lunch and resumes exactly at the afternoon open', async () => {
    const session = await getWatchlistSession(utc('2026-08-31T03:45:00'), openCalendar);
    expect(session.phase).toBe('lunch');
    expect(session.nextCheckAt).toBe('2026-08-31T05:00:00.000Z');
  });

  it('switches phases at the exchange boundaries without a five-second session poll', async () => {
    const morningLastMinute = await getWatchlistSession(utc('2026-08-31T03:29:00'), openCalendar);
    expect(morningLastMinute).toMatchObject({ phase: 'trading', nextCheckAt: '2026-08-31T03:30:00.000Z' });

    const lunchStart = await getWatchlistSession(utc('2026-08-31T03:30:00'), openCalendar);
    expect(lunchStart).toMatchObject({ phase: 'lunch', nextCheckAt: '2026-08-31T05:00:00.000Z' });

    const closeBoundary = await getWatchlistSession(utc('2026-08-31T07:00:00'), openCalendar);
    expect(closeBoundary).toMatchObject({
      phase: 'closed',
      closeRefreshKey: '2026-08-31:close',
      nextCheckAt: '2026-08-31T07:05:00.000Z',
    });
  });

  it('exposes the open date as the close-refresh key after the close', async () => {
    const settling = await getWatchlistSession(utc('2026-08-31T07:02:00'), openCalendar);
    expect(settling).toMatchObject({
      phase: 'closed',
      closeRefreshKey: '2026-08-31:close',
      nextCheckAt: '2026-08-31T07:05:00.000Z',
    });

    const final = await getWatchlistSession(utc('2026-08-31T07:06:00'), openCalendar);
    expect(final).toMatchObject({
      phase: 'closed',
      closeRefreshKey: '2026-08-31:final',
      nextCheckAt: '2026-09-01T01:30:00.000Z',
    });
  });

  it('fails closed for holidays and checks the next Shanghai open boundary', async () => {
    const session = await getWatchlistSession(utc('2026-08-31T03:45:00'), holidayCalendar);
    expect(session).toMatchObject({
      phase: 'closed',
      closeRefreshKey: null,
      nextCheckAt: '2026-09-01T01:30:00.000Z',
    });
  });

  it('returns unknown instead of assuming a missing calendar row is open', async () => {
    const now = utc('2026-08-31T01:30:00');
    const session = await getWatchlistSession(now, missingCalendar);
    expect(session).toMatchObject({
      phase: 'unknown',
      closeRefreshKey: null,
      nextCheckAt: '2026-08-31T01:31:00.000Z',
    });
  });

  it('keeps weekends closed when the calendar has no row', async () => {
    const session = await getWatchlistSession(utc('2026-08-29T02:00:00'), missingCalendar);
    expect(session).toMatchObject({
      phase: 'closed',
      closeRefreshKey: null,
      nextCheckAt: '2026-08-30T01:30:00.000Z',
    });
  });

  it('keeps pre-open and post-close closed when the calendar has no row', async () => {
    const preOpen = await getWatchlistSession(utc('2026-08-31T01:00:00'), missingCalendar);
    expect(preOpen).toMatchObject({ phase: 'closed', nextCheckAt: '2026-08-31T01:30:00.000Z' });

    const postClose = await getWatchlistSession(utc('2026-08-31T07:06:00'), missingCalendar);
    expect(postClose).toMatchObject({ phase: 'closed', nextCheckAt: '2026-09-01T01:30:00.000Z' });
  });

  it('keeps verified open-day evidence through lunch and the two close refreshes', async () => {
    const evidence = async (date: string) => date === '2026-08-31';
    const session = await getWatchlistSession(utc('2026-08-31T01:30:00'), missingCalendar, evidence);
    expect(session).toMatchObject({
      phase: 'trading',
      nextCheckAt: '2026-08-31T03:30:00.000Z',
    });

    const lunch = await getWatchlistSession(utc('2026-08-31T03:45:00'), missingCalendar, evidence);
    expect(lunch).toMatchObject({
      phase: 'lunch',
      nextCheckAt: '2026-08-31T05:00:00.000Z',
    });
    expect(await getWatchlistSession(utc('2026-08-31T07:00:00'), missingCalendar, evidence))
      .toMatchObject({ phase: 'closed', closeRefreshKey: '2026-08-31:close', nextCheckAt: '2026-08-31T07:05:00.000Z' });
    expect(await getWatchlistSession(utc('2026-08-31T07:05:00'), missingCalendar, evidence))
      .toMatchObject({ phase: 'closed', closeRefreshKey: '2026-08-31:final' });
  });
});
