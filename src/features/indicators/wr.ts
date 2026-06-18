import type { Candle } from '@/models';

export interface WrParams {
  period: number;
}

export function calculateWR(candles: Candle[], params: WrParams): (number | null)[] {
  const { period } = params;
  const len = candles.length;
  const result: (number | null)[] = new Array(len).fill(null);

  if (len < period) return result;

  for (let i = period - 1; i < len; i++) {
    let highest = candles[i].high;
    let lowest = candles[i].low;
    for (let j = 1; j < period; j++) {
      const h = candles[i - j].high;
      const l = candles[i - j].low;
      if (h > highest) highest = h;
      if (l < lowest) lowest = l;
    }

    const range = highest - lowest;
    if (range === 0) {
      result[i] = 0;
    } else {
      // WR = (highest - close) / (highest - lowest) * 100
      // Typically displayed as negative or 0 to -100 range
      result[i] = ((highest - candles[i].close) / range) * -100;
    }
  }

  return result;
}
