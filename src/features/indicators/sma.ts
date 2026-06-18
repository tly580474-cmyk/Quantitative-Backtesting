import type { Candle } from '@/models';

export interface SmaParams {
  period: number;
}

export function calculateSMA(candles: Candle[], params: SmaParams): (number | null)[] {
  const { period } = params;
  const result: (number | null)[] = new Array(candles.length).fill(null);

  if (candles.length < period) return result;

  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += candles[i].close;
  }
  result[period - 1] = sum / period;

  for (let i = period; i < candles.length; i++) {
    sum += candles[i].close - candles[i - period].close;
    result[i] = sum / period;
  }

  return result;
}
