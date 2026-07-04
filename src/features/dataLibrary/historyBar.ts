import { apiFetch } from '@/api/client';
import type { Candle } from '@/models';

const YUAN_PER_YI = 100_000_000;

export type AdjustmentMode = 'none' | 'qfq' | 'hfq';

export interface HistoryBar {
  tradeDate: string;
  open: number;
  high: number;
  low: number;
  close: number;
  previousClose?: number;
  volume?: number;
  amount?: number;
  turnoverRatePct?: number;
}

export interface HistoryCandleResponse {
  items: HistoryBar[];
  total: number;
  storage: 'history-v2';
  adjustmentMode: AdjustmentMode;
  factorVersion: string | null;
  adjustmentQualityStatus: 'pass' | 'warning';
  adjustmentWarnings: Array<{
    ruleCode: string;
    details?: Record<string, unknown>;
  }>;
}

/**
 * MySQL history-v2 stores amount in yuan, while Candle.turnover uses 亿元.
 */
export function amountYuanToYi(amount: number | undefined): number | undefined {
  return amount == null ? undefined : amount / YUAN_PER_YI;
}

export function mapHistoryBarsToCandles(
  bars: HistoryBar[],
  symbol: string,
): Candle[] {
  return bars.map((bar) => ({
    time: bar.tradeDate,
    symbol,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
    turnover: amountYuanToYi(bar.amount),
    turnoverRatePct: bar.turnoverRatePct,
  }));
}

export async function fetchHistoryCandles(
  instrumentId: string,
  symbol: string,
  adjustmentMode: AdjustmentMode,
): Promise<{ response: HistoryCandleResponse; candles: Candle[] }> {
  const response = await apiFetch<HistoryCandleResponse>(
    `/api/instruments/${instrumentId}/candles?offset=0&limit=10000`
    + `&adjustmentMode=${adjustmentMode}`,
    { timeoutMs: 60000 },
  );
  return {
    response,
    candles: mapHistoryBarsToCandles(response.items, symbol),
  };
}
