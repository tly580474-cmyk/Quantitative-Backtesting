import { describe, it, expect } from 'vitest';
import { calculateMetrics } from '../metrics';
import type { EquityPoint, Trade } from '@/models';

function makeEquityCurve(values: number[]): EquityPoint[] {
  return values.map((v, i) => ({
    time: `2021-01-${String(i + 1).padStart(2, '0')}`,
    cash: v * 0.5,
    marketValue: v * 0.5,
    equity: v,
    drawdown: 0,
    positionQuantity: 0,
  }));
}

describe('Metrics', () => {
  it('calculates basic metrics for no trades', () => {
    const equity = makeEquityCurve([100000, 100000, 100000]);
    const metrics = calculateMetrics(equity, [], 100000);

    expect(metrics.totalReturn).toBe(0);
    expect(metrics.annualizedReturn).toBe(0);
    expect(metrics.tradeCount).toBe(0);
    expect(metrics.winRate).toBe(0);
  });

  it('calculates total return correctly', () => {
    const equity = makeEquityCurve([100000, 101000, 102000, 103000]);
    const metrics = calculateMetrics(equity, [], 100000);
    expect(metrics.totalReturn).toBeCloseTo(0.03, 4);
  });

  it('calculates negative return', () => {
    const equity = makeEquityCurve([100000, 99000, 98000]);
    const metrics = calculateMetrics(equity, [], 100000);
    expect(metrics.totalReturn).toBeLessThan(0);
  });

  it('calculates max drawdown', () => {
    const equity = makeEquityCurve([100000, 105000, 95000, 102000, 98000]);
    const metrics = calculateMetrics(equity, [], 100000);

    // Peak at 105000 on 01-02, trough at 95000 on 01-03 → DD = (105000 - 95000) / 105000 = 0.09524
    expect(metrics.maxDrawdown).toBeCloseTo(10000 / 105000, 4);
    expect(metrics.maxDrawdownStart).toBe('2021-01-02');
    expect(metrics.maxDrawdownEnd).toBe('2021-01-03');
  });

  it('handles empty equity curve', () => {
    const metrics = calculateMetrics([], [], 100000);
    expect(metrics.finalEquity).toBe(100000);
    expect(metrics.totalReturn).toBe(0);
  });

  it('calculates sharpe ratio for positive returns', () => {
    const values = Array.from({ length: 252 }, (_, i) => 100000 * (1 + i * 0.001));
    const equity = makeEquityCurve(values);
    const metrics = calculateMetrics(equity, [], 100000);
    expect(metrics.sharpeRatio).toBeGreaterThan(0);
    expect(metrics.annualizedVolatility).toBeGreaterThan(0);
    expect(metrics.riskReturnRatio).toBeGreaterThan(0);
  });

  it('returns zero sharpe for flat equity', () => {
    const equity = makeEquityCurve([100000, 100000, 100000, 100000]);
    const metrics = calculateMetrics(equity, [], 100000);
    expect(metrics.annualizedVolatility).toBe(0);
  });

  it('handles no-NaN on zero-volatility portfolio', () => {
    const equity = makeEquityCurve([100000, 100000, 100000]);
    const metrics = calculateMetrics(equity, [], 100000);
    expect(Number.isNaN(metrics.annualizedReturn)).toBe(false);
    expect(Number.isNaN(metrics.sharpeRatio)).toBe(false);
    expect(Number.isNaN(metrics.maxDrawdown)).toBe(false);
    expect(Number.isNaN(metrics.riskReturnRatio)).toBe(false);
    expect(Number.isNaN(metrics.returnMddRatio)).toBe(false);
  });

  it('calculates win rate for trades', () => {
    const equity = makeEquityCurve([100000, 101000, 102000]);
    const trades: Trade[] = [
      {
        id: 't1', orderId: 'o1', time: '2021-01-01', side: 'buy',
        quantity: 100, rawPrice: 10, fillPrice: 10,
        commission: 0.3, tax: 0, slippageCost: 0, amount: 1000,
      },
      {
        id: 't2', orderId: 'o2', time: '2021-01-02', side: 'sell',
        quantity: 100, rawPrice: 12, fillPrice: 12,
        commission: 0.3, tax: 1.2, slippageCost: 0, amount: 1200,
      },
    ];
    const metrics = calculateMetrics(equity, trades, 100000);
    expect(metrics.tradeCount).toBe(1);
    expect(metrics.winRate).toBe(1);
    expect(metrics.profitFactor).toBeGreaterThan(1);
  });

  it('handles profit factor with no losses', () => {
    const equity = makeEquityCurve([100000, 101000]);
    const trades: Trade[] = [
      {
        id: 't1', orderId: 'o1', time: '2021-01-01', side: 'buy',
        quantity: 100, rawPrice: 10, fillPrice: 10,
        commission: 0.3, tax: 0, slippageCost: 0, amount: 1000,
      },
      {
        id: 't2', orderId: 'o2', time: '2021-01-02', side: 'sell',
        quantity: 100, rawPrice: 12, fillPrice: 12,
        commission: 0.3, tax: 1.2, slippageCost: 0, amount: 1200,
      },
    ];
    const metrics = calculateMetrics(equity, trades, 100000);
    expect(metrics.profitFactor).not.toBe(Infinity);
    expect(Number.isFinite(metrics.profitFactor)).toBe(true);
  });

  it('matches multiple DCA buys to one sell without duplicating proceeds', () => {
    const equity = makeEquityCurve([100000, 99800]);
    const trades: Trade[] = [
      { id: 'b1', orderId: 'o1', time: '2021-01-01', side: 'buy', quantity: 100, rawPrice: 10, fillPrice: 10, commission: 0, tax: 0, slippageCost: 0, amount: 1000 },
      { id: 'b2', orderId: 'o2', time: '2021-02-01', side: 'buy', quantity: 100, rawPrice: 20, fillPrice: 20, commission: 0, tax: 0, slippageCost: 0, amount: 2000 },
      { id: 's1', orderId: 'o3', time: '2021-03-01', side: 'sell', quantity: 200, rawPrice: 14, fillPrice: 14, commission: 0, tax: 0, slippageCost: 0, amount: 2800 },
    ];
    const metrics = calculateMetrics(equity, trades, 100000);
    expect(metrics.tradeCount).toBe(1);
    expect(metrics.winRate).toBe(0);
    expect(metrics.profitFactor).toBe(0);
  });
});
