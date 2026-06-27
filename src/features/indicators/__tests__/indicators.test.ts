import { describe, it, expect } from 'vitest';
import type { ActiveIndicator, Candle } from '@/models';
import { calculateSMA } from '../sma';
import { calculateEMA } from '../ema';
import { calculateBOLL } from '../boll';
import { calculateMACD } from '../macd';
import { calculateRSI } from '../rsi';
import { calculateKDJ } from '../kdj';
import { calculateATR } from '../atr';
import { calculateCCI } from '../cci';
import { calculateWR } from '../wr';
import { calculateOBV } from '../obv';
import { calculateVolumeMA } from '../volumeMa';
import {
  calculateBIAS,
  calculateHold,
  calculateReversal,
  calculateVolCluster,
  calculateVolatility,
} from '../phase2Quant';
import { calculateAllIndicators } from '../calculator';
import { getIndicatorById } from '../registry';
import {
  calculateDrawdown,
  calculateHighLowBreakout,
  calculateVolume,
} from '../strategySignals';

function candles(count: number, basePrice = 100): Candle[] {
  const result: Candle[] = [];
  for (let i = 0; i < count; i++) {
    result.push({
      time: `2021-01-${String(i + 1).padStart(2, '0')}`,
      symbol: 'TEST',
      open: basePrice + i,
      high: basePrice + i + 5,
      low: basePrice + i - 5,
      close: basePrice + i + 2,
      volume: 1000000 + i * 10000,
    });
  }
  return result;
}

function candlesFromCloses(closes: number[]): Candle[] {
  return closes.map((close, index) => ({
    time: `2021-02-${String(index + 1).padStart(2, '0')}`,
    symbol: 'TEST',
    open: close,
    high: close + 1,
    low: close - 1,
    close,
  }));
}

describe('SMA', () => {
  it('calculates simple moving average', () => {
    const c = candles(30);
    const result = calculateSMA(c, { period: 20 });
    expect(result[19]).toBeCloseTo(111.5, 1);
    expect(result[20]).not.toBeNull();
    expect(result[29]).not.toBeNull();
  });

  it('returns null for warmup period', () => {
    const c = candles(30);
    const result = calculateSMA(c, { period: 20 });
    for (let i = 0; i < 19; i++) {
      expect(result[i]).toBeNull();
    }
  });

  it('returns all null if not enough data', () => {
    const c = candles(10);
    const result = calculateSMA(c, { period: 20 });
    expect(result.every((v) => v === null)).toBe(true);
  });

  it('result length matches input', () => {
    const c = candles(50);
    const result = calculateSMA(c, { period: 20 });
    expect(result).toHaveLength(50);
  });
});

describe('EMA', () => {
  it('calculates exponential moving average', () => {
    const c = candles(50);
    const result = calculateEMA(c, { period: 20 });
    expect(result[19]).not.toBeNull();
    expect(result[30]).not.toBeNull();
  });

  it('returns null for warmup', () => {
    const c = candles(30);
    const result = calculateEMA(c, { period: 20 });
    for (let i = 0; i < 19; i++) {
      expect(result[i]).toBeNull();
    }
  });

  it('result length matches input', () => {
    const c = candles(30);
    const result = calculateEMA(c, { period: 5 });
    expect(result).toHaveLength(30);
  });
});

describe('Multi moving averages', () => {
  it.each(['sma', 'ema'] as const)('calculates four configurable %s lines', (id) => {
    const definition = getIndicatorById(id)!;
    const active: ActiveIndicator = {
      id,
      definition,
      visible: true,
      paramValues: { period1: 5, period2: 10, period3: 20, period4: 60 },
    };
    const result = calculateAllIndicators(candles(80), [active])[0];

    expect(Object.keys(result.series)).toEqual([
      `${id}1`, `${id}2`, `${id}3`, `${id}4`,
    ]);
    expect(result.series[`${id}1`][4]).not.toBeNull();
    expect(result.series[`${id}4`][58]).toBeNull();
    expect(result.series[`${id}4`][59]).not.toBeNull();
  });

  it.each(['sma', 'ema'] as const)('supports adding and deleting %s periods', (id) => {
    const definition = getIndicatorById(id)!;
    const active: ActiveIndicator = {
      id,
      definition,
      visible: true,
      paramValues: {
        period1: 5,
        period2: 0,
        period3: 20,
        period4: 60,
        period5: 120,
        period6: 0,
        period7: 0,
        period8: 0,
      },
    };
    const result = calculateAllIndicators(candles(150), [active])[0];

    expect(Object.keys(result.series)).toEqual([
      `${id}1`, `${id}3`, `${id}4`, `${id}5`,
    ]);
    expect(result.series[`${id}2`]).toBeUndefined();
    expect(result.series[`${id}5`][119]).not.toBeNull();
  });
});

describe('BOLL', () => {
  it('calculates bollinger bands', () => {
    const c = candles(30);
    const { upper, middle, lower } = calculateBOLL(c, { period: 20, stdDev: 2 });
    expect(upper).toHaveLength(30);
    expect(middle).toHaveLength(30);
    expect(lower).toHaveLength(30);
    expect(middle[19]).not.toBeNull();
    expect(upper[19]!).toBeGreaterThan(middle[19]!);
    expect(lower[19]!).toBeLessThan(middle[19]!);
  });
});

describe('MACD', () => {
  it('calculates MACD', () => {
    const c = candles(100);
    const { dif, dea, histogram } = calculateMACD(c, { fast: 12, slow: 26, signal: 9 });
    expect(dif).toHaveLength(100);
    expect(histogram[34]).not.toBeNull(); // After warmup
  });

  it('matches exact SMA-seeded EMA reference values', () => {
    const c = candlesFromCloses([1, 2, 4, 8, 16, 8, 4, 2, 1, 2]);
    const { dif, dea, histogram } = calculateMACD(c, {
      fast: 3,
      slow: 5,
      signal: 2,
    });

    expect(dif[5]).toBeCloseTo(2.4916666667, 9);
    expect(dea[5]).toBeCloseTo(3.4375, 9);
    expect(histogram[5]).toBeCloseTo(-1.8916666667, 9);
    expect(histogram[9]).toBeCloseTo(-0.1590920782, 9);
  });
});

describe('RSI', () => {
  it('calculates the configurable 6/12/24 RSI series', () => {
    const definition = getIndicatorById('rsi')!;
    const active: ActiveIndicator = {
      id: 'rsi',
      definition,
      visible: true,
      paramValues: { period1: 6, period2: 12, period3: 24 },
    };
    const result = calculateAllIndicators(candles(50), [active])[0];

    expect(Object.keys(result.series)).toEqual(['rsi1', 'rsi2', 'rsi3']);
    expect(result.series.rsi1[6]).not.toBeNull();
    expect(result.series.rsi2[12]).not.toBeNull();
    expect(result.series.rsi3[23]).toBeNull();
    expect(result.series.rsi3[24]).not.toBeNull();
  });

  it('keeps legacy single-period RSI configurations working', () => {
    const definition = getIndicatorById('rsi')!;
    const active: ActiveIndicator = {
      id: 'rsi',
      definition,
      visible: true,
      paramValues: { period: 14 },
    };
    const result = calculateAllIndicators(candles(30), [active])[0];

    expect(Object.keys(result.series)).toEqual(['rsi']);
    expect(result.series.rsi[14]).not.toBeNull();
  });

  it('calculates RSI between 0 and 100', () => {
    const c = candles(50);
    const result = calculateRSI(c, { period: 14 });
    for (let i = 14; i < result.length; i++) {
      if (result[i] !== null) {
        expect(result[i]!).toBeGreaterThanOrEqual(0);
        expect(result[i]!).toBeLessThanOrEqual(100);
      }
    }
  });

  it('returns null for warmup', () => {
    const c = candles(20);
    const result = calculateRSI(c, { period: 14 });
    expect(result[0]).toBeNull();
    expect(result[13]).toBeNull();
  });

  it('matches Wilder RSI reference values', () => {
    const result = calculateRSI(candlesFromCloses([1, 2, 3, 2, 2]), { period: 3 });
    expect(result[3]).toBeCloseTo(66.6666666667, 9);
    expect(result[4]).toBeCloseTo(66.6666666667, 9);
  });

  it('returns neutral 50 when price is completely flat', () => {
    const result = calculateRSI(candlesFromCloses([10, 10, 10, 10, 10]), { period: 3 });
    expect(result[3]).toBe(50);
    expect(result[4]).toBe(50);
  });
});

describe('KDJ', () => {
  it('calculates KDJ', () => {
    const c = candles(50);
    const { k, d, j } = calculateKDJ(c, { n: 9, m1: 3, m2: 3 });
    expect(k).toHaveLength(50);
    expect(d).toHaveLength(50);
    expect(j).toHaveLength(50);
    expect(k[8]).not.toBeNull();
  });
});

describe('ATR', () => {
  it('calculates ATR positive values', () => {
    const c = candles(30);
    const result = calculateATR(c, { period: 14 });
    for (let i = 14; i < result.length; i++) {
      if (result[i] !== null) {
        expect(result[i]!).toBeGreaterThan(0);
      }
    }
  });
});

describe('CCI', () => {
  it('calculates CCI', () => {
    const c = candles(30);
    const result = calculateCCI(c, { period: 20 });
    expect(result[19]).not.toBeNull();
    expect(result).toHaveLength(30);
  });
});

describe('WR', () => {
  it('calculates Williams %R in range [-100, 0]', () => {
    const c = candles(30);
    const result = calculateWR(c, { period: 10 });
    for (let i = 10; i < result.length; i++) {
      if (result[i] !== null) {
        expect(result[i]!).toBeGreaterThanOrEqual(-100);
        expect(result[i]!).toBeLessThanOrEqual(0);
      }
    }
  });

  it('matches the standard negative Williams percent range', () => {
    const c: Candle[] = [
      { time: '2021-03-01', symbol: 'TEST', open: 7, high: 10, low: 5, close: 8 },
      { time: '2021-03-02', symbol: 'TEST', open: 8, high: 12, low: 7, close: 10 },
      { time: '2021-03-03', symbol: 'TEST', open: 9, high: 11, low: 6, close: 9 },
    ];
    const result = calculateWR(c, { period: 3 });
    expect(result[2]).toBeCloseTo(-42.8571428571, 9);
  });
});

describe('OBV', () => {
  it('calculates OBV', () => {
    const c = candles(20);
    const result = calculateOBV(c);
    expect(result).toHaveLength(20);
    expect(result[0]).not.toBeNull();
  });

  it('returns empty array for empty input', () => {
    const result = calculateOBV([]);
    expect(result).toHaveLength(0);
  });
});

describe('Volume MA', () => {
  it('calculates volume moving average', () => {
    const c = candles(50);
    const result = calculateVolumeMA(c, { period: 20 });
    expect(result[19]).not.toBeNull();
    expect(result).toHaveLength(50);
  });
});

describe('Strategy studio signal indicators', () => {
  it('calculates volume average and ratio', () => {
    const c = candles(4);
    c[0].volume = 100;
    c[1].volume = 200;
    c[2].volume = 300;
    c[3].volume = 600;
    const result = calculateVolume(c, { period: 3 });

    expect(result.volumeAverage[1]).toBeNull();
    expect(result.volumeAverage[2]).toBe(200);
    expect(result.volumeRatio[3]).toBeCloseTo(600 / (200 + 300 + 600) * 3, 9);
  });

  it('uses only preceding bars for high/low breakout thresholds', () => {
    const c = candles(4);
    c[0].high = 10; c[0].low = 5;
    c[1].high = 12; c[1].low = 7;
    c[2].high = 99; c[2].low = 1;
    const result = calculateHighLowBreakout(c, { period: 2 });

    expect(result.previousHigh[2]).toBe(12);
    expect(result.previousLow[2]).toBe(5);
    expect(result.previousHigh[3]).toBe(99);
    expect(result.previousLow[3]).toBe(1);
  });

  it('calculates rolling drawdown as a positive decimal', () => {
    const c = candlesFromCloses([100, 120, 108, 90]);
    const result = calculateDrawdown(c, { period: 3 });

    expect(result.peak[2]).toBe(120);
    expect(result.drawdown[2]).toBeCloseTo(0.1, 9);
    expect(result.drawdown[3]).toBeCloseTo(0.25, 9);
  });

  it('exposes all three indicators through the shared calculator', () => {
    const ids = ['volume', 'highLowBreakout', 'drawdown'];
    const results = calculateAllIndicators(
      candles(80),
      ids.map((id) => {
        const definition = getIndicatorById(id)!;
        return {
          id,
          definition,
          visible: true,
          paramValues: Object.fromEntries(definition.params.map((p) => [p.name, p.defaultValue])),
        };
      }),
    );

    expect(results.map((result) => result.id)).toEqual(ids);
    expect(results.every((result) => Object.keys(result.series).length > 0)).toBe(true);
  });
});

describe('Phase 2 quant indicators', () => {
  it('calculates BIAS against a rolling moving average', () => {
    const result = calculateBIAS(candlesFromCloses([100, 100, 100, 110]), { period: 3 });
    expect(result[2]).toBeCloseTo(0, 9);
    expect(result[3]).toBeCloseTo((110 - 103.3333333333) / 103.3333333333, 9);
  });

  it('calculates rolling and annualized volatility', () => {
    const { volatility, annualVolatility } = calculateVolatility(
      candlesFromCloses([100, 101, 100, 102, 101]),
      { period: 3 },
    );
    expect(volatility).toHaveLength(5);
    expect(volatility[2]).toBeNull();
    expect(volatility[3]).not.toBeNull();
    expect(annualVolatility[3]).toBeCloseTo(volatility[3]! * Math.sqrt(252), 9);
  });

  it('calculates volatility clustering from absolute return autocorrelation', () => {
    const result = calculateVolCluster(candlesFromCloses([100, 102, 101, 103, 102, 104]), { period: 3 });
    expect(result).toHaveLength(6);
    expect(result[4]).not.toBeNull();
  });

  it('calculates HOLD return and NAV', () => {
    const { holdReturn, holdNav } = calculateHold(candlesFromCloses([100, 110, 90]));
    expect(holdReturn[0]).toBeCloseTo(0, 9);
    expect(holdReturn[1]).toBeCloseTo(0.1, 9);
    expect(holdReturn[2]).toBeCloseTo(-0.1, 9);
    expect(holdNav[0]).toBeCloseTo(1, 9);
    expect(holdNav[1]).toBeCloseTo(1.1, 9);
    expect(holdNav[2]).toBeCloseTo(0.9, 9);
  });

  it('calculates reversal as negative past return', () => {
    const result = calculateReversal(candlesFromCloses([100, 110, 121]), { period: 2 });
    expect(result[0]).toBeNull();
    expect(result[2]).toBeCloseTo(-0.21, 9);
  });

  it('exposes new indicators through the shared calculator', () => {
    const ids = ['bias', 'volatility', 'volCluster', 'hold', 'reversal'];
    const results = calculateAllIndicators(
      candles(40),
      ids.map((id) => {
        const definition = getIndicatorById(id)!;
        return {
          id,
          definition,
          visible: true,
          paramValues: Object.fromEntries(definition.params.map((p) => [p.name, p.defaultValue])),
        };
      }),
    );
    expect(results.map((result) => result.id)).toEqual(ids);
    expect(results.every((result) => Object.keys(result.series).length > 0)).toBe(true);
  });
});
