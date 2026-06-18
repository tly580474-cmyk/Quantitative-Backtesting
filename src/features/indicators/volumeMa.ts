import type { Candle } from '@/models';

export interface VolumeMaParams {
  period: number;
}

export function calculateVolumeMA(candles: Candle[], params: VolumeMaParams): (number | null)[] {
  const { period } = params;
  const len = candles.length;
  const result: (number | null)[] = new Array(len).fill(null);

  if (len < period) return result;

  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += candles[i].volume ?? 0;
  }
  result[period - 1] = sum / period;

  for (let i = period; i < len; i++) {
    sum += (candles[i].volume ?? 0) - (candles[i - period].volume ?? 0);
    result[i] = sum / period;
  }

  return result;
}
