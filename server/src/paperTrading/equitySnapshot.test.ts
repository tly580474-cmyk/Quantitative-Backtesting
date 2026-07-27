import { describe, expect, it } from 'vitest';
import {
  PAPER_EQUITY_SNAPSHOT_VERSION,
  computeEquitySnapshot,
} from './equitySnapshot.js';

describe('paper trading equity snapshot', () => {
  it('computes first-day snapshot with null daily return and total equity as peak', () => {
    const result = computeEquitySnapshot({
      accountId: 'account-1',
      tradeDate: '2026-07-27',
      cashBalance: 900_000,
      frozenCash: 5_000,
      marketValue: 110_000,
      initialCash: 1_000_000,
      riskRejections: 0,
      previousSnapshot: null,
    });
    expect(result.totalEquity).toBe(1_010_000);
    expect(result.returnRatio).toBeCloseTo(0.01, 6);
    expect(result.dailyReturnRatio).toBeNull();
    expect(result.peakEquity).toBe(1_010_000);
    expect(result.maxDrawdownRatio).toBe(0);
    expect(result.ruleVersion).toBe(PAPER_EQUITY_SNAPSHOT_VERSION);
  });

  it('computes daily return relative to previous total equity', () => {
    const result = computeEquitySnapshot({
      accountId: 'account-1',
      tradeDate: '2026-07-28',
      cashBalance: 950_000,
      frozenCash: 0,
      marketValue: 120_000,
      initialCash: 1_000_000,
      riskRejections: 0,
      previousSnapshot: {
        accountId: 'account-1',
        tradeDate: '2026-07-27',
        cashBalance: 900_000,
        frozenCash: 0,
        marketValue: 100_000,
        totalEquity: 1_000_000,
        initialCash: 1_000_000,
        returnRatio: 0,
        dailyReturnRatio: null,
        maxDrawdownRatio: 0,
        peakEquity: 1_000_000,
        benchmarkCode: null,
        benchmarkClose: null,
        riskRejections: 0,
        ruleVersion: PAPER_EQUITY_SNAPSHOT_VERSION,
        createdAt: '2026-07-27 15:30:00.000',
      },
    });
    expect(result.totalEquity).toBe(1_070_000);
    expect(result.dailyReturnRatio).toBeCloseTo(0.07, 6);
    expect(result.peakEquity).toBe(1_070_000);
    expect(result.maxDrawdownRatio).toBe(0);
  });

  it('records drawdown when current equity drops below historical peak', () => {
    const result = computeEquitySnapshot({
      accountId: 'account-1',
      tradeDate: '2026-07-29',
      cashBalance: 700_000,
      frozenCash: 0,
      marketValue: 200_000,
      initialCash: 1_000_000,
      riskRejections: 0,
      previousSnapshot: {
        accountId: 'account-1',
        tradeDate: '2026-07-28',
        cashBalance: 950_000,
        frozenCash: 0,
        marketValue: 200_000,
        totalEquity: 1_150_000,
        initialCash: 1_000_000,
        returnRatio: 0.15,
        dailyReturnRatio: 0.05,
        maxDrawdownRatio: 0,
        peakEquity: 1_150_000,
        benchmarkCode: null,
        benchmarkClose: null,
        riskRejections: 0,
        ruleVersion: PAPER_EQUITY_SNAPSHOT_VERSION,
        createdAt: '2026-07-28 15:30:00.000',
      },
    });
    // totalEquity = 900_000, peak = 1_150_000
    // drawdown = (1_150_000 - 900_000) / 1_150_000 ≈ 0.2174
    expect(result.totalEquity).toBe(900_000);
    expect(result.peakEquity).toBe(1_150_000);
    expect(result.maxDrawdownRatio).toBeCloseTo(0.21739, 4);
    expect(result.dailyReturnRatio).toBeCloseTo(
      900_000 / 1_150_000 - 1,
      6,
    );
  });

  it('preserves benchmark code and close when provided', () => {
    const result = computeEquitySnapshot({
      accountId: 'account-1',
      tradeDate: '2026-07-27',
      cashBalance: 1_000_000,
      frozenCash: 0,
      marketValue: 0,
      initialCash: 1_000_000,
      riskRejections: 2,
      benchmarkCode: '000300',
      benchmarkClose: 4000.5,
    });
    expect(result.benchmarkCode).toBe('000300');
    expect(result.benchmarkClose).toBe(4000.5);
    expect(result.riskRejections).toBe(2);
  });

  it('returns zero return ratio when initialCash is zero (avoid division by zero)', () => {
    const result = computeEquitySnapshot({
      accountId: 'account-1',
      tradeDate: '2026-07-27',
      cashBalance: 0,
      frozenCash: 0,
      marketValue: 0,
      initialCash: 0,
      riskRejections: 0,
    });
    expect(result.returnRatio).toBe(0);
    expect(result.totalEquity).toBe(0);
  });

  it('retains historical peak across three days of varying equity', () => {
    // Day 1: total = 1_100_000 -> peak = 1_100_000
    const day1 = computeEquitySnapshot({
      accountId: 'account-1',
      tradeDate: '2026-07-27',
      cashBalance: 1_000_000,
      frozenCash: 0,
      marketValue: 100_000,
      initialCash: 1_000_000,
      riskRejections: 0,
      previousSnapshot: null,
    });
    expect(day1.peakEquity).toBe(1_100_000);
    expect(day1.maxDrawdownRatio).toBe(0);

    // Day 2: total = 1_200_000 -> peak updates to 1_200_000
    const day2 = computeEquitySnapshot({
      accountId: 'account-1',
      tradeDate: '2026-07-28',
      cashBalance: 1_050_000,
      frozenCash: 0,
      marketValue: 150_000,
      initialCash: 1_000_000,
      riskRejections: 0,
      previousSnapshot: day1,
    });
    expect(day2.totalEquity).toBe(1_200_000);
    expect(day2.peakEquity).toBe(1_200_000);
    expect(day2.maxDrawdownRatio).toBe(0);

    // Day 3: total = 950_000 -> peak retains 1_200_000, drawdown = 20.83%
    const day3 = computeEquitySnapshot({
      accountId: 'account-1',
      tradeDate: '2026-07-29',
      cashBalance: 800_000,
      frozenCash: 0,
      marketValue: 150_000,
      initialCash: 1_000_000,
      riskRejections: 0,
      previousSnapshot: day2,
    });
    expect(day3.totalEquity).toBe(950_000);
    expect(day3.peakEquity).toBe(1_200_000);
    expect(day3.maxDrawdownRatio).toBeCloseTo((1_200_000 - 950_000) / 1_200_000, 6);
    expect(day3.dailyReturnRatio).toBeCloseTo(950_000 / 1_200_000 - 1, 6);
  });

  it('recovers drawdown to zero when equity reclaims peak', () => {
    const day1 = computeEquitySnapshot({
      accountId: 'account-1',
      tradeDate: '2026-07-27',
      cashBalance: 1_100_000,
      frozenCash: 0,
      marketValue: 0,
      initialCash: 1_000_000,
      riskRejections: 0,
    });
    const drawdownDay = computeEquitySnapshot({
      accountId: 'account-1',
      tradeDate: '2026-07-28',
      cashBalance: 950_000,
      frozenCash: 0,
      marketValue: 0,
      initialCash: 1_000_000,
      riskRejections: 0,
      previousSnapshot: day1,
    });
    expect(drawdownDay.maxDrawdownRatio).toBeGreaterThan(0);
    const recoverDay = computeEquitySnapshot({
      accountId: 'account-1',
      tradeDate: '2026-07-29',
      cashBalance: 1_200_000,
      frozenCash: 0,
      marketValue: 0,
      initialCash: 1_000_000,
      riskRejections: 0,
      previousSnapshot: drawdownDay,
    });
    expect(recoverDay.totalEquity).toBe(1_200_000);
    expect(recoverDay.peakEquity).toBe(1_200_000);
    expect(recoverDay.maxDrawdownRatio).toBe(0);
  });

  it('normalizes negative riskRejections to zero', () => {
    const result = computeEquitySnapshot({
      accountId: 'account-1',
      tradeDate: '2026-07-27',
      cashBalance: 1_000_000,
      frozenCash: 0,
      marketValue: 0,
      initialCash: 1_000_000,
      riskRejections: -5,
    });
    expect(result.riskRejections).toBe(0);
  });
});
