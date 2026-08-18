import { describe, expect, it } from 'vitest';
import type { KlinePoint } from '@/features/marketData/types';
import {
  availableToSell,
  calculateFullPositionQuantity,
  createTrainingPortfolio,
  executeTrainingTrade,
  portfolioEquity,
  recordEquity,
  summarizeTraining,
} from './engine';

function bar(date: string, close: number): KlinePoint {
  return {
    date,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1_000_000,
    isTradable: true,
  };
}

describe('market-sense training engine', () => {
  it('normalizes buys to board lots and charges trading costs', () => {
    const result = executeTrainingTrade(
      createTrainingPortfolio(),
      'buy',
      155,
      bar('2026-01-05', 10),
      80,
    );

    expect(result.error).toBeUndefined();
    expect(result.portfolio.quantity).toBe(100);
    expect(result.portfolio.cash).toBeLessThan(999_000);
    expect(result.portfolio.averageCost).toBeGreaterThan(10);
    expect(result.portfolio.trades[0].commission).toBe(5);
  });

  it('enforces T+1 while allowing the position to be sold on the next bar', () => {
    const bought = executeTrainingTrade(
      createTrainingPortfolio(),
      'buy',
      100,
      bar('2026-01-05', 10),
      80,
    ).portfolio;

    expect(availableToSell(bought, 80)).toBe(0);
    expect(executeTrainingTrade(bought, 'sell', 100, bar('2026-01-05', 10), 80).error)
      .toContain('下一交易日');
    expect(availableToSell(bought, 81)).toBe(100);
    const sold = executeTrainingTrade(bought, 'sell', 100, bar('2026-01-06', 11), 81);
    expect(sold.error).toBeUndefined();
    expect(sold.portfolio.quantity).toBe(0);
    expect(sold.portfolio.realizedPnl).toBeGreaterThan(0);
  });

  it('calculates an affordable all-in quantity without exceeding cash', () => {
    const portfolio = createTrainingPortfolio();
    const quantity = calculateFullPositionQuantity(portfolio, 100);
    const result = executeTrainingTrade(portfolio, 'buy', quantity, bar('2026-01-05', 100), 80);

    expect(quantity).toBeGreaterThan(0);
    expect(quantity % 100).toBe(0);
    expect(result.error).toBeUndefined();
    expect(result.portfolio.cash).toBeGreaterThanOrEqual(0);
  });

  it('summarizes return and maximum drawdown from the equity curve', () => {
    let portfolio = createTrainingPortfolio();
    portfolio = recordEquity(portfolio, bar('2026-01-05', 10));
    portfolio = { ...portfolio, cash: 900_000 };
    portfolio = recordEquity(portfolio, bar('2026-01-06', 10));
    const summary = summarizeTraining(portfolio, 10);

    expect(portfolioEquity(portfolio, 10)).toBe(900_000);
    expect(summary.totalReturnPct).toBeCloseTo(-10);
    expect(summary.maxDrawdownPct).toBeCloseTo(10);
  });
});
