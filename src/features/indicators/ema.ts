import type { Candle } from '@/models';

export interface EmaParams {
  period: number;
}

export function calculateEMA(candles: Candle[], params: EmaParams): (number | null)[] {
  const { period } = params;
  const result: (number | null)[] = new Array(candles.length).fill(null);

  if (candles.length < period) return result;

  const multiplier = 2 / (period + 1);

  // Seed with SMA for the first value
  let ema = 0;
  for (let i = 0; i < period; i++) {
    ema += candles[i].close;
  }
  ema /= period;
  result[period - 1] = ema;

  for (let i = period; i < candles.length; i++) {
    ema = (candles[i].close - ema) * multiplier + ema;
    result[i] = ema;
  }

  return result;
}
