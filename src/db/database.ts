import Dexie, { type Table } from 'dexie';
import type { MarketDataset, StoredCandle, StrategyConfig, BacktestResult, EquityPoint } from '@/models';

export class BacktestDatabase extends Dexie {
  marketDatasets!: Table<MarketDataset, string>;
  candles!: Table<StoredCandle, string>;
  strategyConfigs!: Table<StrategyConfig, string>;
  backtestResults!: Table<BacktestResult, string>;
  equityPoints!: Table<EquityPoint & { resultId: string }, string>;

  constructor() {
    super('BacktestDB');

    this.version(1).stores({
      marketDatasets: 'id, symbol, createdAt',
      candles: '[datasetId+time], datasetId, time',
      strategyConfigs: 'id, strategyId, createdAt',
      backtestResults: 'id, status, startedAt',
      equityPoints: '[resultId+time], resultId, time',
    });

    this.marketDatasets = this.table('marketDatasets');
    this.candles = this.table('candles');
    this.strategyConfigs = this.table('strategyConfigs');
    this.backtestResults = this.table('backtestResults');
    this.equityPoints = this.table('equityPoints');
  }
}

export const db = new BacktestDatabase();
