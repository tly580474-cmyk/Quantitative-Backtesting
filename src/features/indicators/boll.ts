import type { Candle } from '@/models';

export interface BollParams {
  period: number;
  stdDev: number;
}

export interface BollResult {
  upper: (number | null)[];
  middle: (number | null)[];
  lower: (number | null)[];
}

export function calculateBOLL(candles: Candle[], params: BollParams): BollResult {
  const { period, stdDev } = params;
  const len = candles.length;
  const upper: (number | null)[] = new Array(len).fill(null);
  const middle: (number | null)[] = new Array(len).fill(null);
  const lower: (number | null)[] = new Array(len).fill(null);

  if (len < period) return { upper, middle, lower };

  for (let i = period - 1; i < len; i++) {
    let sum = 0;
    for (let j = 0; j < period; j++) {
      sum += candles[i - period + 1 + j].close;
    }
    const ma = sum / period;

    let varianceSum = 0;
    for (let j = 0; j < period; j++) {
      const diff = candles[i - period + 1 + j].close - ma;
      varianceSum += diff * diff;
    }
    const std = Math.sqrt(varianceSum / period);

    middle[i] = ma;
    upper[i] = ma + stdDev * std;
    lower[i] = ma - stdDev * std;
  }

  return { upper, middle, lower };
}
