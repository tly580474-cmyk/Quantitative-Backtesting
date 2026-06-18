import { describe, it, expect } from 'vitest';
import { createPortfolio, applyTrade, computeEquity, createEquityPoint } from '../portfolio';
import type { Trade } from '@/models';

function buyTrade(quantity: number, fillPrice: number, commission = 5): Trade {
  return {
    id: 't1',
    orderId: 'o1',
    time: '2021-01-02',
    side: 'buy',
    quantity,
    rawPrice: fillPrice,
    fillPrice,
    commission,
    tax: 0,
    slippageCost: 0,
    amount: quantity * fillPrice,
  };
}

function sellTrade(quantity: number, fillPrice: number, commission = 5, tax = 0): Trade {
  return {
    id: 't2',
    orderId: 'o2',
    time: '2021-01-10',
    side: 'sell',
    quantity,
    rawPrice: fillPrice,
    fillPrice,
    commission,
    tax,
    slippageCost: 0,
    amount: quantity * fillPrice,
  };
}

describe('Portfolio', () => {
  it('initializes with given capital', () => {
    const p = createPortfolio(100000);
    expect(p.cash).toBe(100000);
    expect(p.positionQuantity).toBe(0);
    expect(p.avgCost).toBe(0);
  });

  it('applies buy trade correctly', () => {
    let p = createPortfolio(100000);
    const trade = buyTrade(1000, 10);
    p = applyTrade(p, trade);

    expect(p.positionQuantity).toBe(1000);
    expect(p.cash).toBe(100000 - 10000 - 5);
    expect(p.avgCost).toBe(10);
  });

  it('applies sell trade correctly', () => {
    let p = createPortfolio(100000);
    p = applyTrade(p, buyTrade(1000, 10));
    p = applyTrade(p, sellTrade(1000, 12, 5, 12));

    expect(p.positionQuantity).toBe(0);
    expect(p.avgCost).toBe(0);
    expect(p.cash).toBe(100000 - 10000 - 5 + 12000 - 5 - 12);
  });

  it('computes equity correctly', () => {
    let p = createPortfolio(100000);
    p = applyTrade(p, buyTrade(1000, 10));

    const equity = computeEquity(p, 11); // 1000 shares * 11 + cash
    expect(equity).toBe(1000 * 11 + p.cash);
  });

  it('tracks cumulative costs', () => {
    let p = createPortfolio(100000);
    p = applyTrade(p, buyTrade(1000, 10, 5));
    p = applyTrade(p, sellTrade(500, 12, 3, 6));

    expect(p.totalCommission).toBe(8);
    expect(p.totalTax).toBe(6);
  });

  it('creates equity point with drawdown', () => {
    let p = createPortfolio(100000);
    const point1 = createEquityPoint('2021-01-01', p, 10, 100000);
    expect(point1.equity).toBe(100000);
    expect(point1.drawdown).toBe(0);

    p = applyTrade(p, buyTrade(1000, 10));
    const point2 = createEquityPoint('2021-01-02', p, 9, 100000);
    expect(point2.drawdown).toBeLessThan(0);
  });

  it('resets avg cost when position is fully closed', () => {
    let p = createPortfolio(100000);
    p = applyTrade(p, buyTrade(500, 10, 5));
    p = applyTrade(p, buyTrade(500, 12, 5));
    expect(p.avgCost).toBeCloseTo(11, 1);

    p = applyTrade(p, sellTrade(1000, 15, 5, 15));
    expect(p.positionQuantity).toBe(0);
    expect(p.avgCost).toBe(0);
  });
});
