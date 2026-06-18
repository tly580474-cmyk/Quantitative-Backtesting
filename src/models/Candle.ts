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
  constituentCount?: number;
}
