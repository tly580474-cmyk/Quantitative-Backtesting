// ─── Candle Data Quality Validators ───────────────────────────────
// Structure and value checks for daily candle data.

import type { DailyCandle } from '../types.js';

// ─── Types ──────────────────────────────────────────────────────────

export interface CandleValidationError {
  tradeDate: string;
  ruleCode: string;
  message: string;
}

export interface ValidationResult {
  errors: CandleValidationError[];
  warnings: CandleValidationError[];
}

// ─── Rule Codes ─────────────────────────────────────────────────────
const RULES = {
  VALUE_NON_POSITIVE: 'VALUE_NON_POSITIVE',
  HIGH_LOW_INVERTED: 'HIGH_LOW_INVERTED',
  HIGH_BELOW_OHLC: 'HIGH_BELOW_OHLC',
  LOW_ABOVE_OHLC: 'LOW_ABOVE_OHLC',
  VOLUME_NEGATIVE: 'VOLUME_NEGATIVE',
  TURNOVER_NEGATIVE: 'TURNOVER_NEGATIVE',
  DUPLICATE_DATE: 'DUPLICATE_DATE',
  DATES_OUT_OF_ORDER: 'DATES_OUT_OF_ORDER',
} as const;

// ─── Single Candle Validation ───────────────────────────────────────

/**
 * Validates the structural integrity of a single daily candle.
 * Returns an array of error message strings — empty if valid.
 * Warnings (like high < open/close or low > open/close) are not
 * included here; they are surfaced through validateCandleSet which
 * separates errors from warnings.
 */
export function validateCandleStructure(candle: DailyCandle): string[] {
  const messages: string[] = [];

  // open, high, low, close must be > 0
  if (candle.open <= 0) {
    messages.push(`open must be > 0, got ${candle.open}`);
  }
  if (candle.high <= 0) {
    messages.push(`high must be > 0, got ${candle.high}`);
  }
  if (candle.low <= 0) {
    messages.push(`low must be > 0, got ${candle.low}`);
  }
  if (candle.close <= 0) {
    messages.push(`close must be > 0, got ${candle.close}`);
  }

  // high >= low (hard error if inverted)
  if (candle.high < candle.low) {
    messages.push(`high (${candle.high}) < low (${candle.low})`);
  }

  return messages;
}

// ─── Candle Set Validation ──────────────────────────────────────────

/**
 * Validates an entire set of daily candles, running structure checks on
 * each candle plus cross-candle checks for duplicates, ordering, and gaps.
 *
 * Returns errors (hard data problems) and warnings (unusual but possible).
 * Gap information (> 1 day between consecutive dates) is logged for
 * diagnostic purposes but not included in the returned result.
 */
export function validateCandleSet(candles: DailyCandle[]): ValidationResult {
  const errors: CandleValidationError[] = [];
  const warnings: CandleValidationError[] = [];

  if (candles.length === 0) {
    return { errors, warnings };
  }

  // Sort by date for consistent processing
  const sorted = [...candles].sort(
    (a, b) => a.tradeDate.localeCompare(b.tradeDate),
  );

  const seenDates = new Set<string>();

  for (let i = 0; i < sorted.length; i++) {
    const candle = sorted[i];

    // ── Structure validation (errors only) ──────────────────────
    const structureErrors = validateCandleStructure(candle);
    for (const msg of structureErrors) {
      errors.push({
        tradeDate: candle.tradeDate,
        ruleCode: RULES.VALUE_NON_POSITIVE,
        message: msg,
      });
    }

    // ── High >= open and high >= close (warning) ────────────────
    if (candle.high < candle.open || candle.high < candle.close) {
      warnings.push({
        tradeDate: candle.tradeDate,
        ruleCode: RULES.HIGH_BELOW_OHLC,
        message: `high (${candle.high}) is below open (${candle.open}) or close (${candle.close})`,
      });
    }

    // ── Low <= open and low <= close (warning) ──────────────────
    if (candle.low > candle.open || candle.low > candle.close) {
      warnings.push({
        tradeDate: candle.tradeDate,
        ruleCode: RULES.LOW_ABOVE_OHLC,
        message: `low (${candle.low}) is above open (${candle.open}) or close (${candle.close})`,
      });
    }

    // ── Volume >= 0 (error if negative) ─────────────────────────
    if (candle.volume < 0) {
      errors.push({
        tradeDate: candle.tradeDate,
        ruleCode: RULES.VOLUME_NEGATIVE,
        message: `volume is negative: ${candle.volume}`,
      });
    }

    // ── Turnover >= 0 if present (warning if negative) ──────────
    if (candle.turnover !== undefined && candle.turnover < 0) {
      warnings.push({
        tradeDate: candle.tradeDate,
        ruleCode: RULES.TURNOVER_NEGATIVE,
        message: `turnover is negative: ${candle.turnover}`,
      });
    }

    // ── Duplicate date check (error) ────────────────────────────
    if (seenDates.has(candle.tradeDate)) {
      errors.push({
        tradeDate: candle.tradeDate,
        ruleCode: RULES.DUPLICATE_DATE,
        message: `duplicate entry for date ${candle.tradeDate}`,
      });
    }
    seenDates.add(candle.tradeDate);

    // ── Date order check (warning) ──────────────────────────────
    if (i > 0) {
      const prevDate = sorted[i - 1].tradeDate;
      if (candle.tradeDate < prevDate) {
        warnings.push({
          tradeDate: candle.tradeDate,
          ruleCode: RULES.DATES_OUT_OF_ORDER,
          message: `date ${candle.tradeDate} appears after ${prevDate} in sorted order`,
        });
      }

      // Gap check — info only, logged but not returned
      const prevMs = new Date(prevDate).getTime();
      const currMs = new Date(candle.tradeDate).getTime();
      const dayDiff = (currMs - prevMs) / (1000 * 60 * 60 * 24);
      if (dayDiff > 1) {
        // Info-level diagnostic: gap detected, not included in return
        console.debug(
          `[validators] Gap of ${dayDiff} days between ${prevDate} and ${candle.tradeDate}`,
        );
      }
    }
  }

  return { errors, warnings };
}
