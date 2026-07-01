import { describe, expect, it } from 'vitest';
import { screenMarketTechnicalRows, type MarketTechnicalScreenCriteria } from './marketTechnicalScreen.js';

const criteria: MarketTechnicalScreenCriteria = {
  markets: ['SH', 'SZ'],
  minChangePct: 0,
  maxChangePct: 7,
  minAmountYi: 1,
  minTurnoverPct: 1,
  minVolumeRatio: 1,
  maxAmplitudePct: 10,
  excludeRiskNames: true,
  limit: 20,
};

describe('market technical screen', () => {
  it('filters risk names, markets and thresholds', () => {
    const result = screenMarketTechnicalRows([
      { code: '600001', name: '甲公司', market: 'SH', price: 10, changePct: 3, amountYi: 8, turnoverPct: 3, amplitudePct: 5, volumeRatio: 1.5 },
      { code: '000002', name: 'ST乙', market: 'SZ', price: 5, changePct: 2, amountYi: 4, turnoverPct: 2, amplitudePct: 4, volumeRatio: 1.2 },
      { code: '920001', name: '丙公司', market: 'BJ', price: 8, changePct: 4, amountYi: 3, turnoverPct: 4, amplitudePct: 6, volumeRatio: 2 },
      { code: '600004', name: '丁公司', market: 'SH', price: 6, changePct: -1, amountYi: 5, turnoverPct: 2, amplitudePct: 4, volumeRatio: 1.1 },
    ], criteria);
    expect(result.map((item) => item.code)).toEqual(['600001']);
    expect(result[0].matchedSignals).toContain('量能放大');
  });

  it('sorts stronger candidates first and respects the limit', () => {
    const result = screenMarketTechnicalRows([
      { code: '600001', name: '甲', market: 'SH', price: 10, changePct: 1, amountYi: 2, turnoverPct: 1, amplitudePct: 5, volumeRatio: 1 },
      { code: '600002', name: '乙', market: 'SH', price: 12, changePct: 4, amountYi: 12, turnoverPct: 5, amplitudePct: 5, volumeRatio: 2 },
    ], { ...criteria, limit: 1 });
    expect(result).toHaveLength(1);
    expect(result[0].code).toBe('600002');
  });
});
