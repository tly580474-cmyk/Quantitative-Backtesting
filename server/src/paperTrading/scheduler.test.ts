import { describe, expect, it } from 'vitest';
import type { ChinaMarketSession } from '../marketData/jobs/marketSession.js';
import { shouldRunPaperTradingMatcher } from './scheduler.js';

function session(
  phase: ChinaMarketSession['phase'],
  isIntradayUpdateWindow: boolean,
): ChinaMarketSession {
  return {
    tradeDate: '2026-07-27',
    minuteOfDay: phase === 'morning' ? 600 : 840,
    weekday: 1,
    phase,
    isIntradayUpdateWindow,
    isDailyBarFinal: false,
  };
}

describe('paper trading scheduler', () => {
  it('runs matching during continuous trading', () => {
    expect(shouldRunPaperTradingMatcher(session('morning', true))).toBe(true);
    expect(shouldRunPaperTradingMatcher(session('afternoon', true))).toBe(true);
  });

  it('skips matching outside trading windows', () => {
    expect(shouldRunPaperTradingMatcher(session('pre_open', false))).toBe(false);
    expect(shouldRunPaperTradingMatcher(session('lunch', false))).toBe(false);
    expect(shouldRunPaperTradingMatcher(session('closed', false))).toBe(false);
  });
});
