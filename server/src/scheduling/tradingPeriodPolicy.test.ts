import { describe, expect, it } from 'vitest';
import {
  isWeekendInTimeZone,
  shouldSkipNonTradingPeriods,
} from './tradingPeriodPolicy.js';

describe('trading period policy', () => {
  it('defaults to skipping non-trading periods', () => {
    expect(shouldSkipNonTradingPeriods({})).toBe(true);
    expect(shouldSkipNonTradingPeriods({
      SCHEDULE_SKIP_NON_TRADING_PERIODS: 'true',
    })).toBe(true);
  });

  it('can be disabled explicitly', () => {
    expect(shouldSkipNonTradingPeriods({
      SCHEDULE_SKIP_NON_TRADING_PERIODS: ' false ',
    })).toBe(false);
  });

  it('uses the target market timezone for weekends', () => {
    const instant = new Date('2026-07-20T02:00:00.000Z');
    expect(isWeekendInTimeZone(instant, 'Asia/Shanghai')).toBe(false);
    expect(isWeekendInTimeZone(instant, 'America/New_York')).toBe(true);
  });
});
