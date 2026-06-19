import Dexie, { type Table } from 'dexie';
import type { MarketDataset, StoredCandle, StrategyConfig, BacktestResult, EquityPoint } from '@/models';
import type { StoredVisualStrategy, StoredStrategyVersion, StoredStrategyDraft } from '@/features/visualStrategies/types';

export class BacktestDatabase extends Dexie {
  marketDatasets!: Table<MarketDataset, string>;
  candles!: Table<StoredCandle, string>;
  strategyConfigs!: Table<StrategyConfig, string>;
  backtestResults!: Table<BacktestResult, string>;
  equityPoints!: Table<EquityPoint & { resultId: string }, string>;
  visualStrategies!: Table<StoredVisualStrategy, string>;
  strategyVersions!: Table<StoredStrategyVersion, string>;
  strategyDrafts!: Table<StoredStrategyDraft, string>;

  constructor() {
    super('BacktestDB');

    this.version(1).stores({
      marketDatasets: 'id, symbol, createdAt',
      candles: '[datasetId+time], datasetId, time',
      strategyConfigs: 'id, strategyId, createdAt',
      backtestResults: 'id, status, startedAt',
      equityPoints: '[resultId+time], resultId, time',
    });

    this.version(2).stores({
      marketDatasets: 'id, symbol, checksum, createdAt',
      candles: '[datasetId+time], datasetId, time',
      strategyConfigs: 'id, strategyId, createdAt',
      backtestResults: 'id, status, startedAt',
      equityPoints: '[resultId+time], resultId, time',
    });

    this.version(3).stores({
      marketDatasets: 'id, symbol, checksum, createdAt',
      candles: '[datasetId+time], datasetId, time',
      strategyConfigs: 'id, strategyId, createdAt',
      backtestResults: 'id, status, startedAt',
      equityPoints: '[resultId+time], resultId, time',
      visualStrategies: 'id, status, updatedAt',
      strategyVersions: '[strategyId+version], strategyId, createdAt',
      strategyDrafts: 'id, strategyId, updatedAt',
    });

    this.marketDatasets = this.table('marketDatasets');
    this.candles = this.table('candles');
    this.strategyConfigs = this.table('strategyConfigs');
    this.backtestResults = this.table('backtestResults');
    this.equityPoints = this.table('equityPoints');
    this.visualStrategies = this.table('visualStrategies');
    this.strategyVersions = this.table('strategyVersions');
    this.strategyDrafts = this.table('strategyDrafts');
  }
}

export const db = new BacktestDatabase();
