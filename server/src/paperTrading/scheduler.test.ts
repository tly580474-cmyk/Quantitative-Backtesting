import { describe, expect, it } from 'vitest';
import type { ChinaMarketSession } from '../marketData/jobs/marketSession.js';
import {
  shouldRunEquitySnapshot,
  shouldRunPaperTradingMatcher,
} from './scheduler.js';

function session(
  phase: ChinaMarketSession['phase'],
  options: { isIntraday?: boolean; isDailyBarFinal?: boolean; tradeDate?: string } = {},
): ChinaMarketSession {
  return {
    tradeDate: options.tradeDate ?? '2026-07-27',
    minuteOfDay: phase === 'morning' ? 600 : phase === 'final' ? 910 : 840,
    weekday: 1,
    phase,
    isIntradayUpdateWindow: options.isIntraday ?? false,
    isDailyBarFinal: options.isDailyBarFinal ?? false,
  };
}

describe('paper trading scheduler', () => {
  it('runs matching during continuous trading', () => {
    expect(shouldRunPaperTradingMatcher(session('morning', { isIntraday: true }))).toBe(true);
    expect(shouldRunPaperTradingMatcher(session('afternoon', { isIntraday: true }))).toBe(true);
  });

  it('skips matching outside trading windows', () => {
    expect(shouldRunPaperTradingMatcher(session('pre_open'))).toBe(false);
    expect(shouldRunPaperTradingMatcher(session('lunch'))).toBe(false);
    expect(shouldRunPaperTradingMatcher(session('closed'))).toBe(false);
  });

  it('runs equity snapshot only after the daily bar is finalized', () => {
    expect(shouldRunEquitySnapshot(session('final', { isDailyBarFinal: true }))).toBe(true);
    expect(shouldRunEquitySnapshot(session('afternoon', { isIntraday: true }))).toBe(false);
    expect(shouldRunEquitySnapshot(session('settling'))).toBe(false);
  });
});
