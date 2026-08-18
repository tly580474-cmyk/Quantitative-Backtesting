import type { KlinePoint } from '@/features/marketData/types';

export interface IndicatorValue {
  date: string;
  ma5: number | null;
  ma10: number | null;
  ma20: number | null;
  bollUpper: number | null;
  bollMiddle: number | null;
  bollLower: number | null;
  rsi14: number | null;
  macdDif: number;
  macdDea: number;
  macdHistogram: number;
}

function sma(values: number[], period: number): Array<number | null> {
  let sum = 0;
  return values.map((value, index) => {
    sum += value;
    if (index >= period) sum -= values[index - period];
    return index >= period - 1 ? sum / period : null;
  });
}

function ema(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  const alpha = 2 / (period + 1);
  const result = [values[0]];
  for (let index = 1; index < values.length; index += 1) {
    result.push(values[index] * alpha + result[index - 1] * (1 - alpha));
  }
  return result;
}

function rsi(values: number[], period: number): Array<number | null> {
  const result: Array<number | null> = values.map(() => null);
  if (values.length <= period) return result;
  let gains = 0;
  let losses = 0;
  for (let index = 1; index <= period; index += 1) {
    const change = values[index] - values[index - 1];
    gains += Math.max(change, 0);
    losses += Math.max(-change, 0);
  }
  let averageGain = gains / period;
  let averageLoss = losses / period;
  result[period] = averageLoss === 0 ? 100 : 100 - 100 / (1 + averageGain / averageLoss);
  for (let index = period + 1; index < values.length; index += 1) {
    const change = values[index] - values[index - 1];
    averageGain = (averageGain * (period - 1) + Math.max(change, 0)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(-change, 0)) / period;
    result[index] = averageLoss === 0 ? 100 : 100 - 100 / (1 + averageGain / averageLoss);
  }
  return result;
}

export function calculateTrainingIndicators(data: KlinePoint[]): IndicatorValue[] {
  const closes = data.map((bar) => bar.close);
  const ma5 = sma(closes, 5);
  const ma10 = sma(closes, 10);
  const ma20 = sma(closes, 20);
  const rsi14 = rsi(closes, 14);
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const dif = closes.map((_value, index) => ema12[index] - ema26[index]);
  const dea = ema(dif, 9);

  return data.map((bar, index) => {
    const middle = ma20[index];
    const window = index >= 19 ? closes.slice(index - 19, index + 1) : [];
    const deviation = middle == null || window.length === 0
      ? null
      : Math.sqrt(window.reduce((sum, value) => sum + (value - middle) ** 2, 0) / 20);
    return {
      date: bar.date,
      ma5: ma5[index],
      ma10: ma10[index],
      ma20: middle,
      bollUpper: middle == null || deviation == null ? null : middle + deviation * 2,
      bollMiddle: middle,
      bollLower: middle == null || deviation == null ? null : middle - deviation * 2,
      rsi14: rsi14[index],
      macdDif: dif[index],
      macdDea: dea[index],
      macdHistogram: (dif[index] - dea[index]) * 2,
    };
  });
}
