import { describe, it, expect } from 'vitest';
import { fillOrder } from '../broker';
import type { Order, BacktestConfig } from '@/models';

const baseConfig: BacktestConfig = {
  backtestMode: 'strategy',
  initialCapital: 100000,
  tradingDays: 0,
  positionSizing: { type: 'percent', value: 1 },
  commissionRate: 0.0003,
  minimumCommission: 5,
  sellTaxRate: 0.001,
  slippageBps: 1,
  tradingUnitMode: 'index',
  minimumTradeAmount: 1,
  dca: { amount: 1000, frequency: 'monthly' },
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

  it('rounds the order value down to the minimum monetary unit', () => {
    const config = { ...baseConfig, minimumTradeAmount: 100 };
    const result = fillOrder(buyOrder(10000), 10, 100000, 0, config);
    expect(result.trade.amount % 100).toBe(0);
  });

  it('supports a one-yuan minimum order for high index prices', () => {
    const result = fillOrder(buyOrder(100), 8500, 100000, 0, baseConfig);
    expect(result.trade.quantity).toBeGreaterThan(0);
    expect(result.trade.amount).toBeGreaterThanOrEqual(1);
    expect(Number.isInteger(result.trade.amount)).toBe(true);
  });

  it('rounds stock-mode purchases down to board lots of 100 shares', () => {
    const config = { ...baseConfig, tradingUnitMode: 'stock' as const };
    const result = fillOrder(buyOrder(255), 10, 100000, 0, config);
    expect(result.trade.quantity).toBe(200);
  });

  it('rejects stock-mode purchases that cannot afford one board lot', () => {
    const config = { ...baseConfig, tradingUnitMode: 'stock' as const };
    const result = fillOrder(buyOrder(100), 10, 900, 0, config);
    expect(result.trade.quantity).toBe(0);
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
    const config = { ...baseConfig, minimumTradeAmount: 2000 };
    const result = fillOrder(buyOrder(10000), 100, 1000, 0, config);
    expect(result.trade.quantity).toBe(0);
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

  it('rounds partial stock-mode sales down to board lots', () => {
    const config = { ...baseConfig, tradingUnitMode: 'stock' as const };
    const result = fillOrder(sellOrder(255), 10, 100000, 500, config);
    expect(result.trade.quantity).toBe(200);
  });

  it('allows a full stock-mode sale to clear an odd-lot tail', () => {
    const config = { ...baseConfig, tradingUnitMode: 'stock' as const };
    const result = fillOrder(sellOrder(50), 10, 100000, 50, config);
    expect(result.trade.quantity).toBe(50);
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
