import { calculateBOLL } from '@/features/indicators/boll';
import { calculateMACD } from '@/features/indicators/macd';
import { calculateVolatility } from '@/features/indicators/phase2Quant';
import { calculateRSI } from '@/features/indicators/rsi';
import type { Candle } from '@/models';

export const VOLATILITY_WEIGHTS = {
  vol_5: 0.5,
  vol_10: 0.15,
  vol_20: 0.35,
} as const;

export const REVERSAL_WEIGHTS = {
  ma_rev_20: 0.2,
  ma_rev_10: 0.15,
  mom_rev_20: 0.15,
  mom_rev_60: 0.12,
  rsi_rev: 0.13,
  boll_rev: 0.05,
  macd_rev: 0.1,
  mom_rev_10: 0.05,
  mom_rev_5: 0.05,
} as const;

export type FactorSeries = Record<string, (number | null)[]>;

export interface CompositeFactorResult {
  score: (number | null)[];
  standardizedFactors: FactorSeries;
}

/**
 * Rolling point-in-time standardization. Only information available on or
 * before the current bar is used.
 */
export function rollingZScore(
  values: readonly (number | null)[],
  window: number,
): (number | null)[] {
  const result: (number | null)[] = new Array(values.length).fill(null);
  if (window < 2) return result;

  for (let i = window - 1; i < values.length; i++) {
    const sample: number[] = [];
    for (let j = i - window + 1; j <= i; j++) {
      const value = values[j];
      if (value == null || !Number.isFinite(value)) {
        sample.length = 0;
        break;
      }
      sample.push(value);
    }
    if (sample.length !== window) continue;

    const mean = sample.reduce((sum, value) => sum + value, 0) / window;
    const variance = sample.reduce(
      (sum, value) => sum + (value - mean) ** 2,
      0,
    ) / (window - 1);
    const standardDeviation = Math.sqrt(variance);
    result[i] = standardDeviation > 0 ? (sample[window - 1] - mean) / standardDeviation : 0;
  }
  return result;
}

function weightedComposite(
  rawFactors: FactorSeries,
  weights: Readonly<Record<string, number>>,
  zScoreWindow: number,
): CompositeFactorResult {
  const standardizedFactors = Object.fromEntries(
    Object.entries(rawFactors).map(([name, values]) => [
      name,
      rollingZScore(values, zScoreWindow),
    ]),
  );
  const length = Object.values(rawFactors)[0]?.length ?? 0;
  const score: (number | null)[] = new Array(length).fill(null);

  for (let i = 0; i < length; i++) {
    let total = 0;
    let complete = true;
    for (const [name, weight] of Object.entries(weights)) {
      const value = standardizedFactors[name]?.[i];
      if (value == null) {
        complete = false;
        break;
      }
      total += value * weight;
    }
    if (complete) score[i] = total;
  }

  return { score, standardizedFactors };
}

function latestWeightedScore(
  rawFactors: FactorSeries,
  weights: Readonly<Record<string, number>>,
  zScoreWindow: number,
): number | null {
  let total = 0;
  for (const [name, weight] of Object.entries(weights)) {
    const values = rawFactors[name];
    const end = values.length - 1;
    if (end < zScoreWindow - 1) return null;
    const sample = values.slice(end - zScoreWindow + 1);
    if (sample.some((value) => value == null || !Number.isFinite(value))) return null;
    const numericSample = sample as number[];
    const mean = numericSample.reduce((sum, value) => sum + value, 0) / zScoreWindow;
    const variance = numericSample.reduce(
      (sum, value) => sum + (value - mean) ** 2,
      0,
    ) / (zScoreWindow - 1);
    const standardDeviation = Math.sqrt(variance);
    const zScore = standardDeviation > 0
      ? (numericSample[numericSample.length - 1] - mean) / standardDeviation
      : 0;
    total += zScore * weight;
  }
  return total;
}

function volatilityRawFactors(candles: Candle[]): FactorSeries {
  return {
    vol_5: calculateVolatility(candles, { period: 5 }).volatility,
    vol_10: calculateVolatility(candles, { period: 10 }).volatility,
    vol_20: calculateVolatility(candles, { period: 20 }).volatility,
  };
}

export function calculateVolatilityComposite(
  candles: Candle[],
  zScoreWindow: number,
): CompositeFactorResult {
  return weightedComposite(volatilityRawFactors(candles), VOLATILITY_WEIGHTS, zScoreWindow);
}

function movingAverageDeviation(candles: Candle[], period: number): (number | null)[] {
  const result: (number | null)[] = new Array(candles.length).fill(null);
  let sum = 0;
  for (let i = 0; i < candles.length; i++) {
    sum += candles[i].close;
    if (i >= period) sum -= candles[i - period].close;
    if (i >= period - 1) {
      const average = sum / period;
      result[i] = average !== 0 ? candles[i].close / average - 1 : null;
    }
  }
  return result;
}

function momentum(candles: Candle[], period: number): (number | null)[] {
  const result: (number | null)[] = new Array(candles.length).fill(null);
  for (let i = period; i < candles.length; i++) {
    const pastClose = candles[i - period].close;
    result[i] = pastClose > 0 ? candles[i].close / pastClose - 1 : null;
  }
  return result;
}

function bollPosition(candles: Candle[]): (number | null)[] {
  const boll = calculateBOLL(candles, { period: 20, stdDev: 2 });
  return candles.map((candle, i) => {
    const upper = boll.upper[i];
    const lower = boll.lower[i];
    const middle = boll.middle[i];
    if (upper == null || lower == null || middle == null) return null;
    if (upper === lower) return 0;
    return (candle.close - middle) / (upper - lower);
  });
}

function negate(values: readonly (number | null)[]): (number | null)[] {
  return values.map((value) => value == null ? null : -value);
}

function reversalRawFactors(candles: Candle[]): FactorSeries {
  const macd = calculateMACD(candles, { fast: 12, slow: 26, signal: 9 });
  return {
    ma_rev_20: negate(movingAverageDeviation(candles, 20)),
    ma_rev_10: negate(movingAverageDeviation(candles, 10)),
    mom_rev_20: negate(momentum(candles, 20)),
    mom_rev_60: negate(momentum(candles, 60)),
    rsi_rev: negate(calculateRSI(candles, { period: 14 })),
    boll_rev: negate(bollPosition(candles)),
    macd_rev: negate(macd.histogram),
    mom_rev_10: negate(momentum(candles, 10)),
    mom_rev_5: negate(momentum(candles, 5)),
  };
}

export function calculateReversalComposite(
  candles: Candle[],
  zScoreWindow: number,
): CompositeFactorResult {
  return weightedComposite(reversalRawFactors(candles), REVERSAL_WEIGHTS, zScoreWindow);
}

export function calculateLatestVolatilityScore(
  candles: Candle[],
  zScoreWindow: number,
): number | null {
  return latestWeightedScore(
    volatilityRawFactors(candles),
    VOLATILITY_WEIGHTS,
    zScoreWindow,
  );
}

export function calculateLatestReversalScore(
  candles: Candle[],
  zScoreWindow: number,
): number | null {
  return latestWeightedScore(
    reversalRawFactors(candles),
    REVERSAL_WEIGHTS,
    zScoreWindow,
  );
}

export function latestScore(result: CompositeFactorResult): number | null {
  return result.score[result.score.length - 1] ?? null;
}
