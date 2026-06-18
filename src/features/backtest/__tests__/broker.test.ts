import { describe, it, expect } from 'vitest';
import { fillOrder } from '../broker';
import type { Order, BacktestConfig } from '@/models';

const baseConfig: BacktestConfig = {
  initialCapital: 100000,
  positionSizing: { type: 'percent', value: 1 },
  commissionRate: 0.0003,
  minimumCommission: 5,
  sellTaxRate: 0.001,
  slippageBps: 1,
  lotSize: 100,
  execution: 'next_open',
  forceCloseAtEnd: false,
};

function buyOrder(quantity: number): Order {
  return {
    id: 'order-1',
    signalTime: '2021-01-01',
    executeTime: '2021-01-02',
    side: 'buy',
    orderType: 'market',
    quantity,
    status: 'pending',
  };
}

function sellOrder(quantity: number): Order {
  return {
    id: 'order-2',
    signalTime: '2021-01-01',
    executeTime: '2021-01-02',
    side: 'sell',
    orderType: 'market',
    quantity,
    status: 'pending',
  };
}

describe('Broker - Buy', () => {
  it('fills buy order with slippage', () => {
    const result = fillOrder(buyOrder(1000), 10, 100000, 0, baseConfig);
    expect(result.trade.quantity).toBe(1000);
    expect(result.trade.fillPrice).toBeGreaterThan(10); // slippage increases price
    expect(result.trade.commission).toBeGreaterThan(0);
    expect(result.trade.tax).toBe(0); // No tax on buy
  });

  it('rounds quantity down to lot size', () => {
    // 100000 * 1 / 10 = 10000 shares, lot size 100 → 100 lots = 10000 shares
    const result = fillOrder(buyOrder(10000), 10, 100000, 0, baseConfig);
    expect(result.trade.quantity % 100).toBe(0);
  });

  it('rejects buy when price is invalid', () => {
    const result = fillOrder(buyOrder(1000), 0, 100000, 0, baseConfig);
    expect(result.trade.quantity).toBe(0);
  });

  it('rejects buy when price is negative', () => {
    const result = fillOrder(buyOrder(1000), -5, 100000, 0, baseConfig);
    expect(result.trade.quantity).toBe(0);
  });

  it('reduces quantity when cash is insufficient', () => {
    // Only 1000 cash, trying to buy 10000 shares at price 100
    const result = fillOrder(buyOrder(10000), 100, 1000, 0, baseConfig);
    expect(result.trade.quantity).toBe(0); // Can't afford even 1 lot
  });

  it('applies minimum commission', () => {
    const config = { ...baseConfig, minimumCommission: 5, commissionRate: 0 };
    const result = fillOrder(buyOrder(100), 10, 100000, 0, config);
    expect(result.trade.commission).toBe(5);
  });

  it('calculates slippage cost correctly', () => {
    const result = fillOrder(buyOrder(1000), 10, 100000, 0, baseConfig);
    const expectedSlippage = result.trade.quantity * (result.trade.fillPrice - 10);
    expect(result.trade.slippageCost).toBeCloseTo(expectedSlippage, 2);
  });
});

describe('Broker - Sell', () => {
  it('fills sell order with slippage', () => {
    const result = fillOrder(sellOrder(500), 10, 100000, 500, baseConfig);
    expect(result.trade.quantity).toBe(500);
    expect(result.trade.fillPrice).toBeLessThan(10); // slippage decreases price
    expect(result.trade.tax).toBeGreaterThan(0); // Tax on sell
  });

  it('rejects sell when no position', () => {
    const result = fillOrder(sellOrder(500), 10, 100000, 0, baseConfig);
    expect(result.trade.quantity).toBe(0);
  });

  it('caps quantity at position size', () => {
    const result = fillOrder(sellOrder(1000), 10, 100000, 300, baseConfig);
    expect(result.trade.quantity).toBe(300);
  });

  it('includes tax on sell', () => {
    const result = fillOrder(sellOrder(1000), 10, 100000, 1000, baseConfig);
    expect(result.trade.tax).toBeCloseTo(result.trade.amount * baseConfig.sellTaxRate, 2);
  });
});

describe('Broker - Edge cases', () => {
  it('handles NaN open price', () => {
    const result = fillOrder(buyOrder(1000), NaN, 100000, 0, baseConfig);
    expect(result.trade.quantity).toBe(0);
  });

  it('handles Infinity open price', () => {
    const result = fillOrder(buyOrder(1000), Infinity, 100000, 0, baseConfig);
    expect(result.trade.quantity).toBe(0);
  });

  it('cash never goes negative after buy', () => {
    const config = { ...baseConfig, positionSizing: { type: 'percent' as const, value: 1 } };
    const result = fillOrder(buyOrder(1000000), 10, 10000, 0, config);
    // Total cost should not exceed cash
    if (result.trade.quantity > 0) {
      const totalCost = result.trade.amount + result.trade.commission;
      expect(totalCost).toBeLessThanOrEqual(10000 + 0.01); // Allow tiny float error
    }
  });
});
