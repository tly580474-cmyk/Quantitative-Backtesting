export interface Candle {
  time: string;
  symbol: string;
  open: number;
  high: number;
  low: number;
  close: number;
  change?: number;
  changePercent?: number;
  volume?: number;
  turnover?: number;
  /** Daily turnover rate in percentage points; 0.41 means 0.41%. */
  turnoverRatePct?: number;
  constituentCount?: number;
}
