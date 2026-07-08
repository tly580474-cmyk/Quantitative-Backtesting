import { describe, expect, it } from 'vitest';
import {
  assertStockDailyUpdateAfterClose,
  getChinaMarketSession,
  shouldRunIntradaySlot,
} from './marketSession.js';

function utc(value: string): Date {
  return new Date(`${value}Z`);
}

describe('China market session', () => {
  it('treats a trading-session bar as provisional', () => {
    const session = getChinaMarketSession(utc('2026-07-06T02:00:00'));
    expect(session).toMatchObject({
      tradeDate: '2026-07-06',
      phase: 'morning',
      isIntradayUpdateWindow: true,
      isDailyBarFinal: false,
    });
  });

  it('finalizes the daily bar after the close grace period', () => {
    const session = getChinaMarketSession(utc('2026-07-06T07:05:00'));
    expect(session.phase).toBe('final');
    expect(session.isDailyBarFinal).toBe(true);
    expect(() => assertStockDailyUpdateAfterClose(session)).not.toThrow();
  });

  it('does not open an intraday slot on weekends', () => {
    const session = getChinaMarketSession(utc('2026-07-05T02:00:00'));
    expect(session.phase).toBe('closed');
    expect(shouldRunIntradaySlot(session, 30)).toBe(false);
  });

  it('aligns intraday updates to each session start', () => {
    expect(shouldRunIntradaySlot(
      getChinaMarketSession(utc('2026-07-06T01:30:00')),
      30,
    )).toBe(true);
    expect(shouldRunIntradaySlot(
      getChinaMarketSession(utc('2026-07-06T05:30:00')),
      30,
    )).toBe(true);
    expect(shouldRunIntradaySlot(
      getChinaMarketSession(utc('2026-07-06T05:45:00')),
      30,
    )).toBe(false);
  });

  it('rejects stock daily updates before the post-close final phase', () => {
    const session = getChinaMarketSession(utc('2026-07-06T06:59:00'));
    expect(session.phase).toBe('afternoon');
    expect(() => assertStockDailyUpdateAfterClose(session)).toThrow(
      '个股行情增量更新仅允许盘后执行',
    );
  });
});
