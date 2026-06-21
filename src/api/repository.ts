import type { MarketDataset, StoredCandle, Candle, BacktestResult, EquityPoint, StrategyConfig } from '@/models';
import type {
  VisualStrategyDocument,
  StoredVisualStrategy,
  StoredStrategyVersion,
  StoredStrategyDraft,
} from '@/features/visualStrategies/types';

export interface IDataRepository {
  getSource(): 'indexeddb' | 'api';
  isAvailable(): Promise<boolean>;

  // Market data
  getDatasets(): Promise<MarketDataset[]>;
  getDataset(id: string): Promise<MarketDataset | undefined>;
  saveDataset(dataset: MarketDataset, candles: Candle[]): Promise<void>;
  deleteDataset(id: string): Promise<void>;
  getCandlesByDataset(datasetId: string): Promise<StoredCandle[]>;
  findDuplicateByChecksum(checksum: string): Promise<MarketDataset | undefined>;
  datasetExists(id: string): Promise<boolean>;

  // Strategy configs
  getStrategyConfigs(): Promise<StrategyConfig[]>;
  saveStrategyConfig(config: StrategyConfig): Promise<void>;
  getStrategyConfig(id: string): Promise<StrategyConfig | undefined>;
  deleteStrategyConfig(id: string): Promise<void>;

  // Backtest results
  getResults(): Promise<BacktestResult[]>;
  getResult(id: string): Promise<BacktestResult | undefined>;
  saveResult(result: BacktestResult, equityCurve: EquityPoint[]): Promise<void>;
  deleteResult(id: string): Promise<void>;
  deleteResults(ids: string[]): Promise<void>;
  getEquityPoints(resultId: string): Promise<EquityPoint[]>;

  // Visual strategies
  getAllVisualStrategies(): Promise<StoredVisualStrategy[]>;
  getVisualStrategyById(id: string): Promise<StoredVisualStrategy | undefined>;
  saveVisualStrategy(strategy: StoredVisualStrategy): Promise<void>;
  deleteVisualStrategy(id: string): Promise<void>;
  publishVisualStrategy(id: string, document: VisualStrategyDocument): Promise<void>;
  getVersionsForStrategy(strategyId: string): Promise<StoredStrategyVersion[]>;
  getStrategyVersion(strategyId: string, version: number): Promise<StoredStrategyVersion | undefined>;
  saveDraft(draft: StoredStrategyDraft): Promise<void>;
  getDraftForStrategy(strategyId: string): Promise<StoredStrategyDraft | undefined>;
  deleteDraft(strategyId: string): Promise<void>;
}
