import type { Candle } from '@/models';

export interface AtrParams {
  period: number;
}

export function calculateATR(candles: Candle[], params: AtrParams): (number | null)[] {
  const { period } = params;
  const len = candles.length;
  const result: (number | null)[] = new Array(len).fill(null);

  if (len < period + 1) return result;

  // Calculate true range for each candle (starting from index 1)
  const tr: number[] = new Array(len).fill(0);
  for (let i = 1; i < len; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;
    tr[i] = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose),
    );
  }

  // First ATR is simple average of first `period` TR values
  let atr = 0;
  for (let i = 1; i <= period; i++) {
    atr += tr[i];
  }
  atr /= period;
  result[period] = atr;

  // Smoothed ATR
  for (let i = period + 1; i < len; i++) {
    atr = (atr * (period - 1) + tr[i]) / period;
    result[i] = atr;
  }

  return result;
}
