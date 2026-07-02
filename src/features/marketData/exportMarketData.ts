import * as XLSX from 'xlsx';
import type { Candle } from '@/models';
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
