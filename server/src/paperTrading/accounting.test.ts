import { describe, expect, it } from 'vitest';
import {
  assertAccountBalances,
  assertPositionBalances,
  calculateBuyReservation,
  calculateBuySettlement,
  calculateSellSettlement,
} from './accounting.js';

const fees = {
  commissionRate: 0.0003,
  minimumCommission: 5,
  sellTaxRate: 0.0005,
};

describe('paper trading accounting', () => {
  it('reserves buy amount plus minimum commission', () => {
    expect(calculateBuyReservation(100, 10, fees)).toEqual({
      amount: 1000,
      commission: 5,
      frozenCash: 1005,
    });
    expect(calculateBuySettlement(100, 10, fees).cashChange).toBe(-1005);
  });

  it('settles sell proceeds and realized pnl after fees and tax', () => {
    expect(calculateSellSettlement(1000, 12, 10, fees)).toEqual({
      amount: 12000,
      commission: 5,
      tax: 6,
      cashChange: 11989,
      realizedPnl: 1989,
    });
  });

  it('enforces cash and position conservation', () => {
    expect(() => assertAccountBalances({
      cashBalance: 10000,
      frozenCash: 1000,
    })).not.toThrow();
    expect(() => assertAccountBalances({
      cashBalance: 100,
      frozenCash: 101,
    })).toThrow('守恒约束');
    expect(() => assertPositionBalances({
      totalQuantity: 1000,
      availableQuantity: 600,
      frozenQuantity: 400,
    })).not.toThrow();
    expect(() => assertPositionBalances({
      totalQuantity: 1000,
      availableQuantity: 700,
      frozenQuantity: 400,
    })).toThrow('守恒约束');
  });
});
