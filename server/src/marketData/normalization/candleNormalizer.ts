/**
 * Candle data normalization.
 *
 * Converts raw provider candle data into the internal DailyCandle format,
 * with field-level validation and graceful handling of invalid rows.
 */

import { randomUUID } from 'node:crypto';
import type { ProviderCandle } from '../providers/provider.js';
import type { DailyCandle } from '../types.js';

// ─── Individual candle normalization ─────────────────────────────────

/**
 * Normalize a single raw provider candle into the internal DailyCandle format.
 *
 * Generates a UUID for the candle, maps fields, assigns timestamps,
 * and performs basic sanity checks (OHLC > 0, volume >= 0).
 * Returns the normalized candle even if it has validation issues —
 * downstream callers should check validity via `validateCandle`.
 */
export function normalizeCandle(
  raw: ProviderCandle,
  instrumentId: string,
  sourceId: string,
): DailyCandle {
  const now = new Date().toISOString();

  return {
    id: randomUUID(),
    instrumentId,
    tradeDate: raw.date,
    open: Number(raw.open),
    high: Number(raw.high),
    low: Number(raw.low),
    close: Number(raw.close),
    volume: Number(raw.volume),
    turnover: raw.turnover != null ? Number(raw.turnover) : undefined,
    turnoverRatePct: raw.turnoverRatePct != null ? Number(raw.turnoverRatePct) : undefined,
    sourceId,
    sourceVersion: '1.0',
    fetchedAt: now,
  };
}

// ─── Batch normalization ─────────────────────────────────────────────

/**
 * Normalize a batch of raw provider candles.
 *
 * Each candle is normalized individually. Rows whose `validateCandle`
 * check fails are silently dropped (a warning is emitted via
 * `console.warn`).  This keeps the pipeline resilient to occasional
 * bad data from providers.
 */
export function normalizeCandles(
  raw: ProviderCandle[],
  instrumentId: string,
  sourceId: string,
): DailyCandle[] {
  const result: DailyCandle[] = [];

  for (const r of raw) {
    const candle = normalizeCandle(r, instrumentId, sourceId);
    const { valid, errors } = validateCandle(candle);

    if (!valid) {
      console.warn(
        `[candleNormalizer] Dropping invalid candle for instrument=${instrumentId} ` +
          `date=${candle.tradeDate} symbol=${r.symbol}: ${errors.join('; ')}`,
      );
      continue;
    }

    result.push(candle);
  }

  return result;
}

// ─── Validation ──────────────────────────────────────────────────────

/**
 * Validate a normalized DailyCandle against business rules.
 *
 * Rules:
 *   - open, high, low, close must be > 0
 *   - high must be >= max(open, close)
 *   - low must be <= min(open, close)
 *   - volume must be >= 0
 *
 * Returns an object with `valid` (boolean) and `errors` (descriptive strings).
 * Does NOT throw.
 */
export function validateCandle(candle: DailyCandle): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  // OHLC must be positive
  if (candle.open <= 0) errors.push('open must be > 0');
  if (candle.high <= 0) errors.push('high must be > 0');
  if (candle.low <= 0) errors.push('low must be > 0');
  if (candle.close <= 0) errors.push('close must be > 0');

  // If any OHLC value is invalid, skip relational checks
  if (errors.length === 0) {
    if (candle.high < Math.max(candle.open, candle.close)) {
      errors.push(
        `high (${candle.high}) must be >= max(open=${candle.open}, close=${candle.close})`,
      );
    }
    if (candle.low > Math.min(candle.open, candle.close)) {
      errors.push(
        `low (${candle.low}) must be <= min(open=${candle.open}, close=${candle.close})`,
      );
    }
  }

  if (candle.volume < 0) errors.push('volume must be >= 0');
  if (candle.turnoverRatePct != null && candle.turnoverRatePct < 0) {
    errors.push('turnoverRatePct must be >= 0');
  }

  return { valid: errors.length === 0, errors };
}
