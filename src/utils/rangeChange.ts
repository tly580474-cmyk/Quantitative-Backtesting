import type { Candle } from '../models';

export interface RangeChangeResult {
  actualStartDate: string;
  actualEndDate: string;
  startClose: number;
  endClose: number;
  change: number;
  changePercent: number;
  totalBars: number;
  isAdjustedStart: boolean;
  isAdjustedEnd: boolean;
}

export type RangeChangeStatus =
  | { type: 'success'; result: RangeChangeResult }
  | { type: 'error'; code: string; message: string };

export function calculateRangeChange(
  candles: Candle[],
  startDate: string,
  endDate: string,
): RangeChangeStatus {
  if (!candles || candles.length === 0) {
    return { type: 'error', code: 'NO_DATA', message: '没有行情数据' };
  }

  if (startDate > endDate) {
    return { type: 'error', code: 'REVERSED_ORDER', message: '起始日期不能晚于结束日期' };
  }

  const sorted = [...candles].sort((a, b) => a.time.localeCompare(b.time));

  let startCandle = sorted.find((c) => c.time >= startDate);
  if (!startCandle) {
    return { type: 'error', code: 'NO_START_DATA', message: '起始日期之后没有有效交易日' };
  }

  const startIndex = sorted.indexOf(startCandle);
  let endCandle: Candle | undefined;

  for (let i = sorted.length - 1; i >= startIndex; i--) {
    if (sorted[i].time <= endDate) {
      endCandle = sorted[i];
      break;
    }
  }

  if (!endCandle) {
    return { type: 'error', code: 'NO_END_DATA', message: '结束日期之前没有有效交易日' };
  }

  if (startCandle.time > endCandle.time) {
    return { type: 'error', code: 'REVERSED_ORDER', message: '起始日期不能晚于结束日期' };
  }

  if (startCandle.close === 0 || startCandle.close == null) {
    return { type: 'error', code: 'INVALID_START_PRICE', message: '起始交易日收盘价无效' };
  }

  if (startCandle.time === endCandle.time) {
    return { type: 'error', code: 'SAME_DAY', message: '起始和结束为同一交易日，无法计算区间涨跌幅' };
  }

  const startIndexFinal = sorted.indexOf(startCandle);
  const endIndex = sorted.indexOf(endCandle);
  const totalBars = endIndex - startIndexFinal + 1;

  return {
    type: 'success',
    result: {
      actualStartDate: startCandle.time,
      actualEndDate: endCandle.time,
      startClose: startCandle.close,
      endClose: endCandle.close,
      change: endCandle.close - startCandle.close,
      changePercent: ((endCandle.close - startCandle.close) / startCandle.close) * 100,
      totalBars,
      isAdjustedStart: startCandle.time !== startDate,
      isAdjustedEnd: endCandle.time !== endDate,
    },
  };
}
