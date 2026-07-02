import type { Candle, ImportWarning, ImportError } from '@/models';
import { isWeekend } from '@/utils/date';

export interface ValidationResult {
  errors: ImportError[];
  warnings: ImportWarning[];
  validCandles: Candle[];
}

/**
 * Validate parsed candles: OHLC rules, date ordering, duplicates, weekends, negatives.
 * Errors block import. Warnings allow import to proceed with notice.
 */
export function validateCandles(candles: Candle[]): ValidationResult {
  const errors: ImportError[] = [];
  const warnings: ImportWarning[] = [];
  const validCandles: Candle[] = [];
  const seenDates = new Map<string, number>(); // date → first index

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const row = i + 1; // 1-based row (row 0 is header)
    let hasError = false;

    // OHLC relationship rules
    if (c.high < c.open || c.high < c.close) {
      errors.push({ row, message: `最高价 ${c.high} 低于开盘价或收盘价` });
      hasError = true;
    }
    if (c.low > c.open || c.low > c.close) {
      errors.push({ row, message: `最低价 ${c.low} 高于开盘价或收盘价` });
      hasError = true;
    }
    if (c.high < c.low) {
      errors.push({ row, message: `最高价 ${c.high} 低于最低价 ${c.low}` });
      hasError = true;
    }

    // Negative values check
    if (c.open < 0 || c.high < 0 || c.low < 0 || c.close < 0) {
      errors.push({ row, message: '价格不得为负' });
      hasError = true;
    }
    if (c.volume != null && c.volume < 0) {
      errors.push({ row, message: '成交量不得为负' });
      hasError = true;
    }
    if (c.turnover != null && c.turnover < 0) {
      errors.push({ row, message: '成交金额不得为负' });
      hasError = true;
    }
    if (c.turnoverRatePct != null && c.turnoverRatePct < 0) {
      errors.push({ row, message: '换手率不得为负' });
      hasError = true;
    }

    // Duplicate date check
    if (seenDates.has(c.time)) {
      errors.push({ row, message: `日期 ${c.time} 重复（首次出现在第 ${seenDates.get(c.time)!} 行）` });
      hasError = true;
    } else {
      seenDates.set(c.time, row);
    }

    if (hasError) continue;

    // Weekend warning (non-blocking)
    if (isWeekend(c.time)) {
      warnings.push({ row, message: `日期 ${c.time} 为非交易日（周末）` });
    }

    validCandles.push(c);
  }

  // Date ordering check (after dedup)
  for (let i = 1; i < validCandles.length; i++) {
    if (validCandles[i].time <= validCandles[i - 1].time) {
      const row = candles.indexOf(validCandles[i]) + 1;
      errors.push({
        row,
        message: `日期 ${validCandles[i].time} 乱序，前一条为 ${validCandles[i - 1].time}`,
      });
      // Remove problematic entries from index i onward
      const kept = validCandles.slice(0, i);
      return { errors, warnings: [...warnings], validCandles: kept };
    }
  }

  // Adjacent duplicate OHLC warning
  for (let i = 1; i < validCandles.length; i++) {
    const prev = validCandles[i - 1];
    const curr = validCandles[i];
    if (
      prev.open === curr.open &&
      prev.high === curr.high &&
      prev.low === curr.low &&
      prev.close === curr.close
    ) {
      const row = candles.indexOf(curr) + 1;
      warnings.push({
        row,
        message: `日期 ${curr.time} 行情与前一天 ${prev.time} 完全一致`,
      });
    }
  }

  return { errors, warnings, validCandles };
}
