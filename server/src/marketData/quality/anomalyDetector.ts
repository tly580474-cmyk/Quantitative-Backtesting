// ─── Anomaly Detector ──────────────────────────────────────────────
// Abnormal price/volume fluctuation detection for daily candle data.

import type { DailyCandle, AdjustmentFactorRecord } from '../types.js';

// ─── Types ──────────────────────────────────────────────────────────

export interface AnomalyResult {
  tradeDate: string;
  ruleCode: string;
  severity: 'warning' | 'blocked';
  message: string;
  actual: number;
  expected?: number;
}

// ─── Rule Codes ─────────────────────────────────────────────────────

const RULES = {
  PRICE_SPIKE: 'PRICE_SPIKE',
  VOLUME_SPIKE: 'VOLUME_SPIKE',
  ZERO_VOLUME: 'ZERO_VOLUME',
  FACTOR_JUMP: 'FACTOR_JUMP',
} as const;

// ─── Thresholds ─────────────────────────────────────────────────────

const PRICE_CHANGE_THRESHOLD = 0.15; // 15% daily change
const VOLUME_SPIKE_MULTIPLIER = 5; // 5x the 20-day average
const VOLUME_AVG_WINDOW = 20;
const FACTOR_JUMP_THRESHOLD = 0.30; // 30% change in adjustment factor

// ─── Detection ──────────────────────────────────────────────────────

/**
 * Detects anomalous price/volume behavior in a set of daily candles.
 *
 * Checks performed:
 * - Price spike: daily change > 15% compared to previous close
 * - Volume spike: volume > 5x 20-day average volume
 * - Zero volume on non-suspension day: volume === 0 (potential data error)
 * - Adjustment factor jump: factor changes by > 30% in a single day
 *
 * @param candles - The candles to analyze (should be sorted by date ascending)
 * @param previousCandles - Historical candles used for baseline (e.g. 20-day avg)
 * @param adjustmentFactors - Optional adjustment factors for factor jump detection
 */
export function detectAnomalies(
  candles: DailyCandle[],
  previousCandles?: DailyCandle[],
  adjustmentFactors?: AdjustmentFactorRecord[],
): AnomalyResult[] {
  const results: AnomalyResult[] = [];

  if (candles.length === 0) return results;

  // Sort candles by date ascending for reliable "previous close" lookups
  const sorted = [...candles].sort(
    (a, b) => a.tradeDate.localeCompare(b.tradeDate),
  );

  // Merge previousCandles with current candles for volume averaging
  // Previous candles should already be sorted and come before current candles
  const allCandles = previousCandles
    ? [...previousCandles, ...sorted].sort(
        (a, b) => a.tradeDate.localeCompare(b.tradeDate),
      )
    : sorted;

  // Build date-to-index map for previous-close lookup within the merged array
  const dateToIndex = new Map<string, number>();
  for (let i = 0; i < allCandles.length; i++) {
    dateToIndex.set(allCandles[i].tradeDate, i);
  }

  // Pre-compute 20-day rolling average volumes
  const volumeAvgMap = computeRollingVolumeAverage(allCandles, VOLUME_AVG_WINDOW);

  // Build adjustment factor lookup if provided
  const factorByDate = new Map<string, number>();
  if (adjustmentFactors) {
    for (const af of adjustmentFactors) {
      factorByDate.set(af.tradeDate, af.factor);
    }
  }

  for (let i = 0; i < sorted.length; i++) {
    const candle = sorted[i];

    // Find this candle's position in the full allCandles array
    const fullIndex = dateToIndex.get(candle.tradeDate);
    if (fullIndex === undefined) continue;

    // ── Price Spike Detection ───────────────────────────────────
    const prevClose = getPreviousClose(fullIndex, allCandles);
    if (prevClose !== null && prevClose > 0) {
      const dailyChange = Math.abs(candle.close - prevClose) / prevClose;
      if (dailyChange > PRICE_CHANGE_THRESHOLD) {
        results.push({
          tradeDate: candle.tradeDate,
          ruleCode: RULES.PRICE_SPIKE,
          severity: 'warning',
          message: `Price change of ${(dailyChange * 100).toFixed(1)}% exceeds ${PRICE_CHANGE_THRESHOLD * 100}% threshold`,
          actual: dailyChange,
          expected: PRICE_CHANGE_THRESHOLD,
        });
      }
    }

    // ── Volume Spike Detection ──────────────────────────────────
    const avgVolume = volumeAvgMap.get(candle.tradeDate);
    if (avgVolume !== undefined && avgVolume > 0) {
      const ratio = candle.volume / avgVolume;
      if (ratio > VOLUME_SPIKE_MULTIPLIER) {
        results.push({
          tradeDate: candle.tradeDate,
          ruleCode: RULES.VOLUME_SPIKE,
          severity: 'warning',
          message: `Volume ${candle.volume} is ${ratio.toFixed(1)}x the 20-day avg (${avgVolume.toFixed(0)})`,
          actual: ratio,
          expected: VOLUME_SPIKE_MULTIPLIER,
        });
      }
    }

    // ── Zero Volume Detection ───────────────────────────────────
    if (candle.volume === 0) {
      results.push({
        tradeDate: candle.tradeDate,
        ruleCode: RULES.ZERO_VOLUME,
        severity: 'warning',
        message: 'Zero volume on a trading day — possible data error',
        actual: 0,
      });
    }

    // ── Adjustment Factor Jump Detection ────────────────────────
    if (adjustmentFactors && factorByDate.size > 0) {
      const currentFactor = factorByDate.get(candle.tradeDate);
      if (currentFactor !== undefined && fullIndex > 0) {
        // Look for the most recent date with a factor
        let prevFactor: number | undefined;
        for (let j = fullIndex - 1; j >= 0; j--) {
          prevFactor = factorByDate.get(allCandles[j].tradeDate);
          if (prevFactor !== undefined) break;
        }
        if (prevFactor !== undefined && prevFactor > 0) {
          const factorChange = Math.abs(
            (currentFactor - prevFactor) / prevFactor,
          );
          if (factorChange > FACTOR_JUMP_THRESHOLD) {
            results.push({
              tradeDate: candle.tradeDate,
              ruleCode: RULES.FACTOR_JUMP,
              severity: 'warning',
              message: `Adjustment factor changed by ${(factorChange * 100).toFixed(1)}% in one day`,
              actual: factorChange,
              expected: FACTOR_JUMP_THRESHOLD,
            });
          }
        }
      }
    }
  }

  return results;
}

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * Computes a 20-day rolling average volume for each candle date.
 * For the first windowSize-1 candles, no average is available (returned as undefined).
 */
function computeRollingVolumeAverage(
  candles: DailyCandle[],
  windowSize: number,
): Map<string, number> {
  const result = new Map<string, number>();

  for (let i = 0; i < candles.length; i++) {
    if (i < windowSize - 1) {
      // Not enough history for a full window
      continue;
    }

    let sum = 0;
    for (let j = i - windowSize + 1; j <= i; j++) {
      sum += candles[j].volume;
    }
    result.set(candles[i].tradeDate, sum / windowSize);
  }

  return result;
}

/**
 * Gets the previous trading day's close price, either from the adjacent
 * candle in the array or from the close-by-date map as fallback.
 */
function getPreviousClose(
  currentIndex: number,
  allCandles: DailyCandle[],
): number | null {
  if (currentIndex > 0) {
    return allCandles[currentIndex - 1].close;
  }
  return null;
}
