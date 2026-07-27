import { describe, expect, it } from 'vitest';
import {
  applySlippage,
  calculateCommission,
  calculateSellTax,
  normalizeStockBuyQuantity,
  normalizeStockSellQuantity,
  TRADING_PRECISION,
} from '../../../../shared/trading-rules/index.js';

describe('shared trading rules', () => {
  it('keeps fee and slippage calculations deterministic', () => {
    expect(applySlippage(10, 'buy', 1)).toBeCloseTo(10.001, 8);
    expect(applySlippage(10, 'sell', 1)).toBeCloseTo(9.999, 8);
    expect(calculateCommission(1000, 0.0003, 5)).toBe(5);
    expect(calculateCommission(100000, 0.0003, 5)).toBe(30);
    expect(calculateSellTax(100000, 0.001)).toBe(100);
  });

  it('uses board lots for buys and permits a full odd-lot exit', () => {
    expect(TRADING_PRECISION.stockLotSize).toBe(100);
    expect(normalizeStockBuyQuantity(255)).toBe(200);
    expect(normalizeStockSellQuantity(255, 500)).toBe(200);
    expect(normalizeStockSellQuantity(50, 50)).toBe(50);
  });
});
