import type { Candle } from '@/models';

export interface CciParams {
  period: number;
}

export function calculateCCI(candles: Candle[], params: CciParams): (number | null)[] {
  const { period } = params;
  const len = candles.length;
  const result: (number | null)[] = new Array(len).fill(null);

  if (len < period) return result;

  for (let i = period - 1; i < len; i++) {
    // Typical price = (high + low + close) / 3
    let tpSum = 0;
    const tps: number[] = [];
    for (let j = 0; j < period; j++) {
      const c = candles[i - period + 1 + j];
      const tp = (c.high + c.low + c.close) / 3;
      tps.push(tp);
      tpSum += tp;
    }
    const tpMA = tpSum / period;

    let mdSum = 0;
    for (const tp of tps) {
      mdSum += Math.abs(tp - tpMA);
    }
    const md = mdSum / period;

    if (md === 0) {
      result[i] = 0;
    } else {
      const currentTP = (candles[i].high + candles[i].low + candles[i].close) / 3;
      result[i] = (currentTP - tpMA) / (0.015 * md);
    }
  }

  return result;
}
