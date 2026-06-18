import type { Candle } from '@/models';

export interface MacdParams {
  fast: number;
  slow: number;
  signal: number;
}

export interface MacdResult {
  dif: (number | null)[];
  dea: (number | null)[];
  histogram: (number | null)[];
}

export function calculateMACD(candles: Candle[], params: MacdParams): MacdResult {
  const { fast, slow, signal } = params;
  const len = candles.length;
  const dif: (number | null)[] = new Array(len).fill(null);
  const dea: (number | null)[] = new Array(len).fill(null);
  const histogram: (number | null)[] = new Array(len).fill(null);

  if (len < slow) return { dif, dea, histogram };

  // Calculate EMA fast and EMA slow
  const fastEMA = calcEMA(candles, fast);
  const slowEMA = calcEMA(candles, slow);

  // DIF = EMA(fast) - EMA(slow)
  for (let i = 0; i < len; i++) {
    if (fastEMA[i] != null && slowEMA[i] != null) {
      dif[i] = fastEMA[i]! - slowEMA[i]!;
    }
  }

  // DEA = EMA of DIF with signal period
  const deaStart = slow + signal - 2;
  if (dif[deaStart] != null) {
    let deaSum = 0;
    let deaCount = 0;
    for (let i = slow - 1; i <= deaStart; i++) {
      if (dif[i] != null) {
        deaSum += dif[i]!;
        deaCount++;
      }
    }
    if (deaCount > 0) {
      dea[deaStart] = deaSum / deaCount;
    }

    const multiplier = 2 / (signal + 1);
    for (let i = deaStart + 1; i < len; i++) {
      if (dif[i] != null && dea[i - 1] != null) {
        dea[i] = (dif[i]! - dea[i - 1]!) * multiplier + dea[i - 1]!;
      }
    }
  }

  // Histogram = 2 * (DIF - DEA)
  for (let i = 0; i < len; i++) {
    if (dif[i] != null && dea[i] != null) {
      histogram[i] = 2 * (dif[i]! - dea[i]!);
    }
  }

  return { dif, dea, histogram };
}

function calcEMA(candles: Candle[], period: number): (number | null)[] {
  const len = candles.length;
  const result: (number | null)[] = new Array(len).fill(null);
  if (len < period) return result;

  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += candles[i].close;
  }
  result[period - 1] = sum / period;

  const multiplier = 2 / (period + 1);
  for (let i = period; i < len; i++) {
    result[i] = (candles[i].close - result[i - 1]!) * multiplier + result[i - 1]!;
  }

  return result;
}
