import * as XLSX from 'xlsx';
import { apiFetch } from '@/api/client';
import type { Candle } from '@/models';
import { fetchHistoryCandles, type AdjustmentMode } from '@/features/dataLibrary/historyBar';
import type { KlinePoint, StockQuote } from './types';

export function toCandles(points: KlinePoint[], quote: Pick<StockQuote, 'code'>): Candle[] {
  return points.map((point, index) => {
    const previous = index > 0 ? points[index - 1] : undefined;
    const change = previous ? point.close - previous.close : undefined;
    const changePercent = previous && previous.close !== 0 ? (change! / previous.close) * 100 : undefined;
    return {
      time: point.date,
      symbol: quote.code,
      open: point.open,
      high: point.high,
      low: point.low,
      close: point.close,
      change,
      changePercent,
      volume: point.volume,
      turnoverRatePct: point.turnoverRatePct,
    };
  });
}

export function exportMarketKlinesToExcel(quote: StockQuote, points: KlinePoint[]): string {
  const rows = toCandles(points, quote).map((candle) => ({
    日期: candle.time,
    代码: quote.code,
    名称: quote.name,
    开盘: candle.open,
    最高: candle.high,
    最低: candle.low,
    收盘: candle.close,
    涨跌额: candle.change ?? null,
    涨跌幅百分比: candle.changePercent ?? null,
    成交量: candle.volume ?? null,
    换手率百分比: candle.turnoverRatePct ?? null,
  }));
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.json_to_sheet(rows);
  sheet['!autofilter'] = { ref: `A1:K${Math.max(1, rows.length + 1)}` };
  sheet['!freeze'] = { xSplit: 0, ySplit: 1, topLeftCell: 'A2', activePane: 'bottomLeft', state: 'frozen' };
  sheet['!cols'] = [
    { wch: 12 },
    { wch: 10 },
    { wch: 14 },
    { wch: 12 },
    { wch: 12 },
    { wch: 12 },
    { wch: 12 },
    { wch: 12 },
    { wch: 14 },
    { wch: 14 },
    { wch: 14 },
  ];
  XLSX.utils.book_append_sheet(workbook, sheet, '日K行情');

  const stamp = new Date().toISOString().slice(0, 10);
  const fileName = `${quote.code}-${quote.name}-日K行情-${stamp}.xlsx`;
  const data = XLSX.write(workbook, { type: 'array', bookType: 'xlsx', cellStyles: true });
  const url = URL.createObjectURL(new Blob([data], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
  return fileName;
}

export interface AdjustedKlineDatasets {
  /** 不复权 */
  raw: KlinePoint[] | null;
  /** 前复权 */
  qfq: KlinePoint[] | null;
  /** 后复权 */
  hfq: KlinePoint[] | null;
}

function candlesToKlinePoints(candles: Candle[]): KlinePoint[] {
  return candles.map((candle) => ({
    date: candle.time,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume ?? 0,
    turnoverRatePct: candle.turnoverRatePct,
  }));
}

/**
 * 通过行情数据库（history-v2）按 instrumentId 拉取三种复权口径的日 K。
 * 单口径失败不影响其余口径，返回 null 表示该口径不可用。
 */
export async function fetchAdjustedDatasets(
  instrumentId: string,
  symbol: string,
): Promise<AdjustedKlineDatasets> {
  const modes: AdjustmentMode[] = ['none', 'qfq', 'hfq'];
  const results = await Promise.all(
    modes.map(async (mode): Promise<KlinePoint[] | null> => {
      try {
        const { candles } = await fetchHistoryCandles(instrumentId, symbol, mode);
        return candlesToKlinePoints(candles);
      } catch {
        return null;
      }
    }),
  );
  return { raw: results[0], qfq: results[1], hfq: results[2] };
}

export function exportAdjustedKlinesToExcel(
  quote: Pick<StockQuote, 'code' | 'name'>,
  datasets: AdjustedKlineDatasets,
): string {
  const sheets: Array<{ name: string; points: KlinePoint[] }> = [];
  if (datasets.raw && datasets.raw.length > 0) sheets.push({ name: '不复权', points: datasets.raw });
  if (datasets.qfq && datasets.qfq.length > 0) sheets.push({ name: '前复权', points: datasets.qfq });
  if (datasets.hfq && datasets.hfq.length > 0) sheets.push({ name: '后复权', points: datasets.hfq });

  const workbook = XLSX.utils.book_new();
  for (const sheet of sheets) {
    const rows = sheet.points.map((point) => ({
      日期: point.date,
      代码: quote.code,
      名称: quote.name,
      开盘: point.open,
      最高: point.high,
      最低: point.low,
      收盘: point.close,
      成交量: point.volume ?? null,
      换手率百分比: point.turnoverRatePct ?? null,
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    ws['!autofilter'] = { ref: `A1:I${Math.max(1, rows.length + 1)}` };
    ws['!freeze'] = { xSplit: 0, ySplit: 1, topLeftCell: 'A2', activePane: 'bottomLeft', state: 'frozen' };
    ws['!cols'] = [
      { wch: 12 },
      { wch: 10 },
      { wch: 14 },
      { wch: 12 },
      { wch: 12 },
      { wch: 12 },
      { wch: 12 },
      { wch: 14 },
      { wch: 14 },
    ];
    XLSX.utils.book_append_sheet(workbook, ws, sheet.name);
  }

  const stamp = new Date().toISOString().slice(0, 10);
  const fileName = `${quote.code}-${quote.name}-复权行情-${stamp}.xlsx`;
  const data = XLSX.write(workbook, { type: 'array', bookType: 'xlsx', cellStyles: true });
  const url = URL.createObjectURL(new Blob([data], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
  return fileName;
}

export interface ResolvedInstrument {
  id: string;
  name: string;
}

/** 通过代码/符号反查行情数据库中的 instrument，用于未携带 instrumentId 的场景。 */
export async function resolveInstrumentBySymbol(symbol: string): Promise<ResolvedInstrument | null> {
  try {
    const result = await apiFetch<{ items: Array<{ id: string; name: string }> }>(
      `/api/instruments?symbol=${encodeURIComponent(symbol)}&limit=1`,
    );
    const item = result.items?.[0];
    return item ? { id: item.id, name: item.name } : null;
  } catch {
    return null;
  }
}

/**
 * 通过个股代码接口（腾讯复权 K 线）按三种口径拉取日 K，用于未接入行情数据库的场景。
 */
export async function fetchAdjustedDatasetsByCode(code: string): Promise<AdjustedKlineDatasets> {
  const modes: Array<'none' | 'qfq' | 'hfq'> = ['none', 'qfq', 'hfq'];
  const results = await Promise.all(
    modes.map(async (mode): Promise<KlinePoint[] | null> => {
      try {
        const data = await apiFetch<{ items: KlinePoint[] }>(
          `/api/market-data/stocks/${encodeURIComponent(code)}/kline?period=day&adjustmentMode=${mode}`,
        );
        return data.items?.length ? data.items : null;
      } catch {
        return null;
      }
    }),
  );
  return { raw: results[0], qfq: results[1], hfq: results[2] };
}
