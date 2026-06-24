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
import {
  calculateBIAS,
  calculateHold,
  calculateReversal,
  calculateVolCluster,
  calculateVolatility,
} from './phase2Quant';

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
      const legacyPeriod = paramValues.period;
      const periods = Array.from({ length: 8 }, (_, index) =>
        paramValues[`period${index + 1}`]
          ?? (index === 0 ? legacyPeriod ?? 5 : [10, 20, 60][index - 1] ?? 0),
      );
      return {
        id,
        series: Object.fromEntries(periods.flatMap((period, index) =>
          period >= 2
            ? [[`sma${index + 1}`, calculateSMA(candles, { period })]]
            : [],
        )),
      };
    }
    case 'ema': {
      const legacyPeriod = paramValues.period;
      const periods = Array.from({ length: 8 }, (_, index) =>
        paramValues[`period${index + 1}`]
          ?? (index === 0 ? legacyPeriod ?? 5 : [10, 20, 60][index - 1] ?? 0),
      );
      return {
        id,
        series: Object.fromEntries(periods.flatMap((period, index) =>
          period >= 2
            ? [[`ema${index + 1}`, calculateEMA(candles, { period })]]
            : [],
        )),
      };
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
    case 'bias': {
      const values = calculateBIAS(candles, { period: paramValues.period });
      return { id, series: { bias: values } };
    }
    case 'volatility': {
      const { volatility, annualVolatility } = calculateVolatility(candles, {
        period: paramValues.period,
      });
      return { id, series: { volatility, annualVolatility } };
    }
    case 'volCluster': {
      const values = calculateVolCluster(candles, { period: paramValues.period });
      return { id, series: { volCluster: values } };
    }
    case 'hold': {
      const { holdReturn, holdNav } = calculateHold(candles);
      return { id, series: { holdReturn, holdNav } };
    }
    case 'reversal': {
      const values = calculateReversal(candles, { period: paramValues.period });
      return { id, series: { reversal: values } };
    }
    default:
      return { id, series: {} };
  }
}
