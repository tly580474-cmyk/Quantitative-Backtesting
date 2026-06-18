import type { Candle } from '@/models';

export interface RsiParams {
  period: number;
}

export function calculateRSI(candles: Candle[], params: RsiParams): (number | null)[] {
  const { period } = params;
  const len = candles.length;
  const result: (number | null)[] = new Array(len).fill(null);

  if (len < period + 1) return result;

  let avgGain = 0;
  let avgLoss = 0;

  // First average gain/loss
  for (let i = 1; i <= period; i++) {
    const change = candles[i].close - candles[i - 1].close;
    if (change > 0) avgGain += change;
    else avgLoss += Math.abs(change);
  }
  avgGain /= period;
  avgLoss /= period;

  if (avgLoss === 0) {
    result[period] = 100;
  } else {
    const rs = avgGain / avgLoss;
    result[period] = 100 - 100 / (1 + rs);
  }

  // Subsequent smoothed RSI
  for (let i = period + 1; i < len; i++) {
    const change = candles[i].close - candles[i - 1].close;
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;

    if (avgLoss === 0) {
      result[i] = 100;
    } else {
      const rs = avgGain / avgLoss;
      result[i] = 100 - 100 / (1 + rs);
    }
  }

  return result;
}
