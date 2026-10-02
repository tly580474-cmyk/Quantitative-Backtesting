import type { ChartPeriod } from '@/features/chart/timeframe';

export interface SupertrendBar {
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface SupertrendParams {
  period: number;
  multiplier: number;
}

export interface SupertrendResult {
  value: (number | null)[];
  direction: (1 | -1 | null)[]; // 1: bullish support, -1: bearish resistance
  up: (number | null)[];
  down: (number | null)[];
  atr: (number | null)[];
}

// Deterministic display presets, not fitted to the data or a claim of optimality.
// The reference 15-minute chart uses ATR(10) × 3. Longer bars need fewer samples.
export const SUPERTREND_PRESETS: Readonly<Record<ChartPeriod, Readonly<SupertrendParams>>> = {
  minute1: { period: 14, multiplier: 3.5 },
  minute5: { period: 12, multiplier: 3 },
  minute15: { period: 10, multiplier: 3 },
  minute30: { period: 10, multiplier: 3 },
  minute60: { period: 10, multiplier: 2.5 },
  minute120: { period: 10, multiplier: 2.5 },
  day: { period: 10, multiplier: 3 },
  week: { period: 10, multiplier: 3 },
  month: { period: 6, multiplier: 2.5 },
  quarter: { period: 4, multiplier: 2.5 },
  year: { period: 3, multiplier: 2.5 },
};

export function resolveSupertrendParams(
  timeframe: ChartPeriod = 'day',
  values: Record<string, number> = {},
): SupertrendParams {
  if (values.auto !== 0) return { ...SUPERTREND_PRESETS[timeframe] };
  return { period: values.period ?? 10, multiplier: values.multiplier ?? 3 };
}

/** Wilder ATR and trailing bands on the chart's own price basis.
 * https://www.tradingview.com/support/solutions/43000634738-supertrend/
 * Never substitute an unadjusted quote's previousClose for the plotted close.
 * Overnight/weekend/limit gaps count as volatility; elapsed time adds no bars.
 */
export function calculateSupertrend(
  bars: readonly SupertrendBar[],
  { period, multiplier }: SupertrendParams = SUPERTREND_PRESETS.day,
): SupertrendResult {
  if (!Number.isInteger(period) || period < 1 || !Number.isFinite(multiplier) || multiplier <= 0) {
    throw new RangeError('Supertrend requires an integer ATR period ≥ 1 and a positive multiplier');
  }
  const result: SupertrendResult = {
    value: Array(bars.length).fill(null), direction: Array(bars.length).fill(null),
    up: Array(bars.length).fill(null), down: Array(bars.length).fill(null), atr: Array(bars.length).fill(null),
  };
  let previousClose: number | null = null;
  let count = 0;
  let seed = 0;
  let atr: number | null = null;
  let upper = 0;
  let lower = 0;
  let direction: 1 | -1 = -1;

  bars.forEach((bar, index) => {
    const { open, high, low, close } = bar;
    if (![open, high, low, close].every(Number.isFinite)
      || high < Math.max(open, close, low) || low > Math.min(open, close)) {
      // An invalid observation breaks continuity. Re-seed rather than poisoning
      // all later values or silently measuring a multi-bar gap as one candle.
      previousClose = null;
      count = 0;
      seed = 0;
      atr = null;
      direction = -1;
      return;
    }
    const tr = previousClose == null ? high - low : Math.max(
      high - low, Math.abs(high - previousClose), Math.abs(low - previousClose),
    );
    count += 1;
    if (atr == null) {
      seed += tr;
      if (count < period) {
        previousClose = close;
        return;
      }
      atr = seed / period;
      upper = (high + low) / 2 + multiplier * atr;
      lower = (high + low) / 2 - multiplier * atr;
    } else {
      atr = (atr * (period - 1) + tr) / period;
      const basicUpper = (high + low) / 2 + multiplier * atr;
      const basicLower = (high + low) / 2 - multiplier * atr;
      upper = basicUpper < upper || previousClose! > upper ? basicUpper : upper;
      lower = basicLower > lower || previousClose! < lower ? basicLower : lower;
      // Compare the close to the carried/current band, not the wick or the
      // newly widened basic band. Equality preserves the existing direction.
      direction = direction === -1 ? (close > upper ? 1 : -1) : (close < lower ? -1 : 1);
    }
    const value = direction === 1 ? lower : upper;
    result.atr[index] = atr;
    result.value[index] = value;
    result.direction[index] = direction;
    result[direction === 1 ? 'up' : 'down'][index] = value;
    previousClose = close;
  });
  return result;
}
