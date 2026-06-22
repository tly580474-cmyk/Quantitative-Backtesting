// ─── Calendar-Based Missing Data Detection ─────────────────────────
// Uses the trading calendar to identify dates where we should have
// candle data but don't, and distinguishes genuine gaps from suspensions.

import {
  getOpenTradingDays,
  getLatestTradeDate,
  isTradeDate,
} from '../repositories/calendarRepository.js';
import { getDailyCandles } from '../repositories/marketDataRepository.js';
import { getInstrument } from '../repositories/instrumentRepository.js';

// ─── Types ──────────────────────────────────────────────────────────

export interface MissingDayResult {
  instrumentId: string;
  missing: string[];
  suspended: string[];
  total: number;
}

// ─── Trading Day Calendar Check ─────────────────────────────────────

/**
 * Detects trading days within the given range for which no candle data
 * exists in the database. Respects instrument listing/delisting dates
 * to avoid false positives.
 */
export async function detectMissingTradingDays(
  instrumentId: string,
  startDate: string,
  endDate: string,
  market: string,
): Promise<MissingDayResult> {
  // Load instrument to respect listDate and delistDate boundaries
  const instrument = await getInstrument(instrumentId);
  const effectiveStart = instrument?.listDate && instrument.listDate > startDate
    ? instrument.listDate
    : startDate;
  const effectiveEnd = instrument?.delistDate && instrument.delistDate < endDate
    ? instrument.delistDate
    : endDate;

  // Get all open trading days in range from calendar
  const tradingDays = await getOpenTradingDays(market, effectiveStart, effectiveEnd);
  const tradingDaySet = new Set(tradingDays);

  if (tradingDays.length === 0) {
    return { instrumentId, missing: [], suspended: [], total: 0 };
  }

  // Get actual candles from DB for this instrument in the range
  const { data: candles } = await getDailyCandles(instrumentId, {
    startDate: effectiveStart,
    endDate: effectiveEnd,
  });
  const candleDateSet = new Set(candles.map((c) => c.tradeDate));

  // Dates that are trading days but have no candle data
  const missingDates = tradingDays.filter((d) => !candleDateSet.has(d));

  // Distinguish suspension vs genuine missing
  const { suspended, missing } = await distinguishSuspensionVsMissing(
    missingDates,
    instrumentId,
    candleDateSet,
    tradingDaySet,
  );

  return {
    instrumentId,
    missing,
    suspended,
    total: missing.length,
  };
}

// ─── Suspension Detection Heuristic ─────────────────────────────────

/**
 * Categorizes missing dates as either suspension (停牌) or genuinely
 * missing data.
 *
 * Heuristic: if a missing date has existing candle data within
 * +/- 5 trading days, it's likely the instrument was suspended.
 * Otherwise, it's a data gap that needs backfilling.
 */
export async function distinguishSuspensionVsMissing(
  missingDates: string[],
  instrumentId: string,
  candleDateSet?: Set<string>,
  tradingDaySet?: Set<string>,
): Promise<{ suspended: string[]; missing: string[] }> {
  const suspended: string[] = [];
  const genuinelyMissing: string[] = [];

  // If we already have the candle date set, use it; otherwise query
  let existingDates: Set<string>;
  if (candleDateSet) {
    existingDates = candleDateSet;
  } else {
    const { data: candles } = await getDailyCandles(instrumentId);
    existingDates = new Set(candles.map((c) => c.tradeDate));
  }

  // If we already have the trading day set, use it; otherwise query
  let tradingDays: Set<string> | undefined;
  if (tradingDaySet) {
    tradingDays = tradingDaySet;
  }

  for (const date of missingDates) {
    const isSuspension = hasSurroundingData(
      date,
      existingDates,
      5,
      tradingDays,
    );

    if (isSuspension) {
      suspended.push(date);
    } else {
      genuinelyMissing.push(date);
    }
  }

  return { suspended, missing: genuinelyMissing };
}

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * Checks whether a missing date is surrounded by existing data within
 * `windowSize` trading days on both sides. If so, the gap is likely a
 * suspension rather than a data quality issue.
 *
 * When a tradingDaySet is provided, window is counted in trading days;
 * otherwise, in calendar days.
 */
function hasSurroundingData(
  date: string,
  existingDates: Set<string>,
  windowSize: number,
  tradingDays?: Set<string>,
): boolean {
  const targetMs = new Date(date).getTime();
  const dayMs = 1000 * 60 * 60 * 24;

  let hasDataBefore = false;
  let hasDataAfter = false;

  if (tradingDays) {
    // Walk trading days backward/forward to check within window
    const sortedTradingDays = Array.from(tradingDays).sort();

    const targetIndex = sortedTradingDays.indexOf(date);
    if (targetIndex === -1) {
      // Date is not a trading day at all — it's not a data gap
      return false;
    }

    // Check previous trading days
    for (let i = targetIndex - 1; i >= Math.max(0, targetIndex - windowSize); i--) {
      if (existingDates.has(sortedTradingDays[i])) {
        hasDataBefore = true;
        break;
      }
    }

    // Check next trading days
    for (
      let i = targetIndex + 1;
      i < Math.min(sortedTradingDays.length, targetIndex + windowSize + 1);
      i++
    ) {
      if (existingDates.has(sortedTradingDays[i])) {
        hasDataAfter = true;
        break;
      }
    }
  } else {
    // Fall back to calendar day window
    for (let offset = 1; offset <= windowSize; offset++) {
      const beforeDate = formatDate(new Date(targetMs - offset * dayMs));
      const afterDate = formatDate(new Date(targetMs + offset * dayMs));

      if (!hasDataBefore && existingDates.has(beforeDate)) {
        hasDataBefore = true;
      }
      if (!hasDataAfter && existingDates.has(afterDate)) {
        hasDataAfter = true;
      }
      if (hasDataBefore && hasDataAfter) break;
    }
  }

  return hasDataBefore && hasDataAfter;
}

function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
