/**
 * Price adjustment calculations.
 *
 * Implements forward-adjusted (前复权 / qfq) and backward-adjusted
 * (后复权 / hfq) price transformations.  These are applied on-the-fly
 * to DailyCandle data and are not persisted — the returned AdjustedCandle
 * objects are derived ephemerally for charting and backtesting.
 *
 * Forward adjustment (前复权):
 *   Adjusts *historical* prices so that the *current* price remains
 *   unchanged.  Earlier prices are scaled DOWN by the cumulative effect
 *   of all intervening corporate actions (dividends, splits).
 *
 *   Formula:  adjPrice = price * (latestFactor / currentFactor)
 *
 * Backward adjustment (后复权):
 *   Adjusts *later* prices so that the *earliest* price remains
 *   unchanged.  Later prices are scaled UP by the cumulative effect
 *   of all intervening corporate actions.
 *
 *   Formula:  adjPrice = price * (currentFactor / earliestFactor)
 */

import type { DailyCandle, AdjustmentFactorRecord, AdjustedCandle } from '../types.js';

// ─── Factor map ──────────────────────────────────────────────────────

/**
 * Build a lookup map from trade date (ISO string) to cumulative
 * adjustment factor.
 *
 * If multiple factors exist for the same date (should not happen in
 * practice), the last one wins.
 */
export function buildAdjustmentFactorMap(
  factors: AdjustmentFactorRecord[],
): Map<string, number> {
  const map = new Map<string, number>();
  for (const f of factors) {
    map.set(f.tradeDate, f.factor);
  }
  return map;
}

// ─── Forward-adjusted (前复权) ───────────────────────────────────────

/**
 * Calculate forward-adjusted (前复权) prices.
 *
 * Sorts candles by date ascending.  For each candle, the adjusted
 * OHLC values are `price * (latestFactor / factorAtDate)`.
 *
 * If no factor is found for a given date the most recent factor at
 * or before that date is used.  If there is no factor at all, the
 * raw price is returned unchanged.
 */
export function calculateForwardAdjusted(
  candles: DailyCandle[],
  factors: AdjustmentFactorRecord[],
): AdjustedCandle[] {
  if (candles.length === 0) return [];

  const factorMap = buildAdjustmentFactorMap(factors);
  const factorDates = Array.from(factorMap.keys()).sort();

  if (factorDates.length === 0) {
    // No factors — return candles as-is with mode 'none'
    return candles.map((c) => toAdjustedCandle(c, 'none'));
  }

  const latestFactor = factorMap.get(factorDates[factorDates.length - 1])!;

  // Sort candles by date ascending
  const sorted = [...candles].sort((a, b) =>
    a.tradeDate.localeCompare(b.tradeDate),
  );

  return sorted.map((candle) => {
    const factorAtDate = lookupFactor(candle.tradeDate, factorMap, factorDates);
    const ratio = factorAtDate > 0 ? latestFactor / factorAtDate : 1;

    return {
      tradeDate: candle.tradeDate,
      open: round(candle.open * ratio),
      high: round(candle.high * ratio),
      low: round(candle.low * ratio),
      close: round(candle.close * ratio),
      volume: candle.volume,
      turnover: candle.turnover,
      adjustmentMode: 'qfq',
    };
  });
}

// ─── Backward-adjusted (后复权) ──────────────────────────────────────

/**
 * Calculate backward-adjusted (后复权) prices.
 *
 * Sorts candles by date ascending.  For each candle, the adjusted
 * OHLC values are `price * (factorAtDate / earliestFactor)`.
 *
 * Factor lookup uses the same fallback logic as forward adjustment.
 */
export function calculateBackwardAdjusted(
  candles: DailyCandle[],
  factors: AdjustmentFactorRecord[],
): AdjustedCandle[] {
  if (candles.length === 0) return [];

  const factorMap = buildAdjustmentFactorMap(factors);
  const factorDates = Array.from(factorMap.keys()).sort();

  if (factorDates.length === 0) {
    return candles.map((c) => toAdjustedCandle(c, 'none'));
  }

  const earliestFactor = factorMap.get(factorDates[0])!;

  const sorted = [...candles].sort((a, b) =>
    a.tradeDate.localeCompare(b.tradeDate),
  );

  return sorted.map((candle) => {
    const factorAtDate = lookupFactor(candle.tradeDate, factorMap, factorDates);
    const ratio = earliestFactor > 0 ? factorAtDate / earliestFactor : 1;

    return {
      tradeDate: candle.tradeDate,
      open: round(candle.open * ratio),
      high: round(candle.high * ratio),
      low: round(candle.low * ratio),
      close: round(candle.close * ratio),
      volume: candle.volume,
      turnover: candle.turnover,
      adjustmentMode: 'hfq',
    };
  });
}

// ─── Internal helpers ────────────────────────────────────────────────

/**
 * Look up the effective factor for `tradeDate`.
 *
 * Uses the factor entry whose date is the latest date <= tradeDate.
 * If no such entry exists (tradeDate is before the first factor date),
 * returns 1.0.
 */
function lookupFactor(
  tradeDate: string,
  factorMap: Map<string, number>,
  sortedDates: string[],
): number {
  // Binary search for the greatest date <= tradeDate
  let lo = 0;
  let hi = sortedDates.length - 1;
  let best: string | null = null;

  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const cmp = sortedDates[mid].localeCompare(tradeDate);
    if (cmp <= 0) {
      best = sortedDates[mid];
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  if (best === null) return 1.0;
  return factorMap.get(best) ?? 1.0;
}

/**
 * Convert a DailyCandle to an unadjusted AdjustedCandle.
 */
function toAdjustedCandle(
  candle: DailyCandle,
  mode: AdjustedCandle['adjustmentMode'],
): AdjustedCandle {
  return {
    tradeDate: candle.tradeDate,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume,
    turnover: candle.turnover,
    adjustmentMode: mode,
  };
}

/**
 * Round to 4 decimal places to avoid floating-point noise.
 */
function round(value: number): number {
  return Math.round(value * 1e4) / 1e4;
}
