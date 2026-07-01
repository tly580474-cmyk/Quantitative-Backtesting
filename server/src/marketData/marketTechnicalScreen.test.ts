import { describe, expect, it } from 'vitest';
import {
  analyzeHistoricalTechnicals,
  filterEnrichedCandidates,
  screenMarketTechnicalRows,
  type MarketTechnicalScreenCriteria,
} from './marketTechnicalScreen.js';

const criteria: MarketTechnicalScreenCriteria = {
  markets: ['SH', 'SZ'],
  minChangePct: 0,
  maxChangePct: 7,
  minAmountYi: 1,
  minTurnoverPct: 1,
  minVolumeRatio: 1,
  maxAmplitudePct: 10,
  excludeRiskNames: true,
  trend: 'any',
  returnPeriod: 20,
  minPeriodReturn: -30,
  maxPeriodReturn: 30,
  streakDirection: 'any',
  minStreakDays: 2,
  minRsi: 0,
  maxRsi: 100,
  kdjSignal: 'any',
  macdSignal: 'any',
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

  it('calculates moving averages, returns, streak and oscillators', () => {
    const candles = Array.from({ length: 80 }, (_, index) => ({
      date: `2026-01-${String(index + 1).padStart(2, '0')}`,
      open: 10 + index * 0.1,
      high: 10.3 + index * 0.1,
      low: 9.8 + index * 0.1,
      close: 10.2 + index * 0.1,
      volume: 1000 + index,
    }));
    const indicators = analyzeHistoricalTechnicals(candles);
    expect(indicators?.trend).toBe('bullish');
    expect(indicators?.return20d).toBeGreaterThan(10);
    expect(indicators?.streak).toBe(79);
    expect(indicators?.rsi14).toBe(100);
    expect(indicators?.kdjK).toBeTypeOf('number');
    expect(indicators?.macdDif).toBeTypeOf('number');
  });

  it('applies historical trend and RSI filters after enrichment', () => {
    const base = screenMarketTechnicalRows([
      { code: '600001', name: '甲', market: 'SH', price: 10, changePct: 1, amountYi: 2, turnoverPct: 1, amplitudePct: 5, volumeRatio: 1 },
    ], criteria)[0];
    const result = filterEnrichedCandidates([{
      ...base,
      indicators: {
        asOf: '2026-06-30',
        close: 12,
        ma5: 11.8,
        ma10: 11.5,
        ma20: 11,
        ma60: 10,
        trend: 'bullish',
        return5d: 3,
        return10d: 5,
        return20d: 8,
        streak: 3,
        rsi14: 62,
        kdjK: 55,
        kdjD: 50,
        kdjJ: 65,
        kdjSignal: 'golden',
        macdDif: 0.2,
        macdDea: 0.1,
        macdHistogram: 0.2,
        macdSignal: 'golden',
      },
    }], {
      ...criteria,
      trend: 'bullish',
      streakDirection: 'up',
      minStreakDays: 3,
      minRsi: 50,
      maxRsi: 70,
      kdjSignal: 'golden',
      macdSignal: 'golden',
    });
    expect(result).toHaveLength(1);
    expect(result[0].matchedSignals).toContain('均线多头');
  });
});
