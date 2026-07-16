import { describe, expect, it } from 'vitest';
import { isReturnBasis, RETURN_BASES } from './returnBasis.js';

describe('return basis catalog', () => {
  it('uses mutually explicit identifiers for stock and official-index returns', () => {
    expect(RETURN_BASES.qfqAdjustedStockPrice.id).not.toBe(RETURN_BASES.officialPriceIndex.id);
    expect(isReturnBasis('qfq_adjusted_stock_price_return')).toBe(true);
    expect(isReturnBasis('total_return')).toBe(false);
  });
});
