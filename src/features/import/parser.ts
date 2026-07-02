import type { Candle } from '@/models';
import { parseDate } from '@/utils/date';
import { parseNumber, parsePercentPoints } from '@/utils/number';
import { mapHeaders } from './headerMapper';

export interface ParseResult {
  candles: Candle[];
  warnings: { row: number; message: string }[];
  errors: { row: number; message: string }[];
}

/**
 * Parse SheetJS sheet data (array of arrays) into Candle[].
 * Row 0 is the header. Data rows start at index 1.
 */
export function parseSheetData(rows: unknown[][]): ParseResult {
  const candles: Candle[] = [];
  const warnings: ParseResult['warnings'] = [];
  const errors: ParseResult['errors'] = [];

  if (rows.length < 2) {
    errors.push({ row: 0, message: '文件为空或只有表头行' });
    return { candles, warnings, errors };
  }

  const headerRow = rows[0];
  const { mapping, missingFields } = mapHeaders(headerRow);

  if (missingFields.length > 0) {
    errors.push({
      row: 0,
      message: `缺少必填列: ${missingFields.join(', ')}`,
    });
    return { candles, warnings, errors };
  }

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const candle = buildCandle(row, mapping, i);

    if (!candle) {
      errors.push({ row: i, message: '行数据为空' });
      continue;
    }

    if (candle.error) {
      errors.push({ row: i, message: candle.error });
      continue;
    }

    candles.push(candle.value!);
  }

  return { candles, warnings, errors };
}

function buildCandle(
  row: unknown[],
  mapping: Record<number, string>,
  rowIndex: number,
): { value?: Candle; error?: string } | null {
  if (!row || row.every(c => c == null || String(c).trim() === '')) return null;

  const values: Record<string, unknown> = {};
  for (let col = 0; col < row.length; col++) {
    const field = mapping[col];
    if (field) {
      values[field] = row[col];
    }
  }

  const dateStr = parseDate(values['date']);
  if (!dateStr) {
    return { error: `无法解析日期: ${values['date']}` };
  }

  const open = parseNumber(values['open']);
  const high = parseNumber(values['high']);
  const low = parseNumber(values['low']);
  const close = parseNumber(values['close']);

  if (Number.isNaN(open) || Number.isNaN(high) || Number.isNaN(low) || Number.isNaN(close)) {
    return { error: `OHLC 数据无法转换为数值` };
  }

  const candle: Candle = {
    time: dateStr,
    symbol: String(values['symbol'] ?? ''),
    open,
    high,
    low,
    close,
  };

  const change = parseNumber(values['change']);
  if (!Number.isNaN(change)) candle.change = change;

  const changePercent = parsePercentPoints(values['changePercent']);
  if (!Number.isNaN(changePercent)) candle.changePercent = changePercent;

  const volume = parseNumber(values['volume']);
  if (!Number.isNaN(volume)) candle.volume = volume;

  const turnover = parseNumber(values['turnover']);
  if (!Number.isNaN(turnover)) candle.turnover = turnover;

  const turnoverRatePct = parsePercentPoints(values['turnoverRatePct']);
  if (!Number.isNaN(turnoverRatePct)) candle.turnoverRatePct = turnoverRatePct;

  const cc = parseNumber(values['constituentCount']);
  if (!Number.isNaN(cc)) candle.constituentCount = cc;

  return { value: candle };
}
