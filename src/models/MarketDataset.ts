import type { Candle } from './Candle';

export interface MarketDataset {
  id: string;
  name: string;
  symbol: string;
  timeframe: '1d';
  startTime: string;
  endTime: string;
  count: number;
  sourceFileName?: string;
  checksum: string;
  createdAt: string;
  updatedAt: string;
}

export interface StoredCandle extends Candle {
  datasetId: string;
}
