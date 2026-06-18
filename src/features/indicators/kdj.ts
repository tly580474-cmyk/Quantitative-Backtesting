import type { Candle } from '@/models';

export interface KdjParams {
  n: number;   // RSV period
  m1: number;  // K smoothing
  m2: number;  // D smoothing
}

export interface KdjResult {
  k: (number | null)[];
  d: (number | null)[];
  j: (number | null)[];
}

export function calculateKDJ(candles: Candle[], params: KdjParams): KdjResult {
  const { n, m1, m2 } = params;
  const len = candles.length;
  const k: (number | null)[] = new Array(len).fill(null);
  const d: (number | null)[] = new Array(len).fill(null);
  const j: (number | null)[] = new Array(len).fill(null);

  if (len < n) return { k, d, j };

  // Start K/D at 50 for the first valid position
  let prevK = 50;
  let prevD = 50;

  for (let i = n - 1; i < len; i++) {
    // Find highest high and lowest low in the last n periods
    let highest = candles[i].high;
    let lowest = candles[i].low;
    for (let jj = 1; jj < n; jj++) {
      const h = candles[i - jj].high;
      const l = candles[i - jj].low;
      if (h > highest) highest = h;
      if (l < lowest) lowest = l;
    }

    // RSV
    const range = highest - lowest;
    const rsv = range === 0 ? 50 : ((candles[i].close - lowest) / range) * 100;

    // K = 2/3 * prevK + 1/3 * RSV  =>  (m1-1)/m1 * prevK + 1/m1 * RSV
    const newK = ((m1 - 1) / m1) * prevK + (1 / m1) * rsv;
    const newD = ((m2 - 1) / m2) * prevD + (1 / m2) * newK;
    const newJ = 3 * newK - 2 * newD;

    k[i] = newK;
    d[i] = newD;
    j[i] = newJ;

    prevK = newK;
    prevD = newD;
  }

  return { k, d, j };
}
