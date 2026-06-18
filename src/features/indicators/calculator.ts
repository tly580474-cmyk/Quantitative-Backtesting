import type { Candle, ActiveIndicator, IndicatorResult } from '@/models';
import { calculateSMA } from './sma';
import { calculateEMA } from './ema';
import { calculateBOLL } from './boll';
import { calculateMACD } from './macd';
import { calculateRSI } from './rsi';
import { calculateKDJ } from './kdj';
import { calculateATR } from './atr';
import { calculateCCI } from './cci';
import { calculateWR } from './wr';
import { calculateOBV } from './obv';
import { calculateVolumeMA } from './volumeMa';

/**
 * Calculate all active indicators against the given candles.
 * Returns results aligned by candle index.
 */
export function calculateAllIndicators(
  candles: Candle[],
  actives: ActiveIndicator[],
): IndicatorResult[] {
  return actives
    .filter(a => a.visible)
    .map(a => calculateOne(candles, a));
}

function calculateOne(candles: Candle[], active: ActiveIndicator): IndicatorResult {
  const { id, paramValues } = active;

  switch (id) {
    case 'sma': {
      const values = calculateSMA(candles, { period: paramValues.period });
      return { id, series: { sma: values } };
    }
    case 'ema': {
      const values = calculateEMA(candles, { period: paramValues.period });
      return { id, series: { ema: values } };
    }
    case 'boll': {
      const { upper, middle, lower } = calculateBOLL(candles, {
        period: paramValues.period,
        stdDev: paramValues.stdDev,
      });
      return { id, series: { upper, middle, lower } };
    }
    case 'macd': {
      const { dif, dea, histogram } = calculateMACD(candles, {
        fast: paramValues.fast,
        slow: paramValues.slow,
        signal: paramValues.signal,
      });
      return { id, series: { dif, dea, histogram } };
    }
    case 'rsi': {
      const values = calculateRSI(candles, { period: paramValues.period });
      return { id, series: { rsi: values } };
    }
    case 'kdj': {
      const { k, d, j } = calculateKDJ(candles, {
        n: paramValues.n,
        m1: paramValues.m1,
        m2: paramValues.m2,
      });
      return { id, series: { k, d, j } };
    }
    case 'atr': {
      const values = calculateATR(candles, { period: paramValues.period });
      return { id, series: { atr: values } };
    }
    case 'cci': {
      const values = calculateCCI(candles, { period: paramValues.period });
      return { id, series: { cci: values } };
    }
    case 'wr': {
      const values = calculateWR(candles, { period: paramValues.period });
      return { id, series: { wr: values } };
    }
    case 'obv': {
      const values = calculateOBV(candles);
      return { id, series: { obv: values } };
    }
    case 'volumeMa': {
      const values = calculateVolumeMA(candles, { period: paramValues.period });
      return { id, series: { volumeMa: values } };
    }
    default:
      return { id, series: {} };
  }
}
