import type { Candle } from '@/models';

export function calculateOBV(candles: Candle[]): (number | null)[] {
  const len = candles.length;
  const result: (number | null)[] = new Array(len).fill(null);

  if (len === 0) return result;

  let obv = 0;
  for (let i = 0; i < len; i++) {
    const volume = candles[i].volume ?? 0;

    if (i === 0) {
      obv = volume;
    } else if (candles[i].close > candles[i - 1].close) {
      obv += volume;
    } else if (candles[i].close < candles[i - 1].close) {
      obv -= volume;
    }
    result[i] = obv;
  }

  return result;
}
