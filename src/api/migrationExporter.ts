import { db } from '@/db/database';
import type { MarketDataset, StoredCandle, BacktestResult, EquityPoint, StrategyConfig } from '@/models';
import type {
  StoredVisualStrategy,
  StoredStrategyVersion,
  StoredStrategyDraft,
} from '@/features/visualStrategies/types';

export interface MigrationTableSummary {
  name: string;
  count: number;
}

export interface MigrationPayload {
  version: string;
  exportedAt: string;
  tables: {
    marketDatasets: MarketDataset[];
    candles: StoredCandle[];
    strategyConfigs: StrategyConfig[];
    backtestResults: BacktestResult[];
    equityPoints: (EquityPoint & { resultId: string })[];
    visualStrategies: StoredVisualStrategy[];
    strategyVersions: StoredStrategyVersion[];
    strategyDrafts: StoredStrategyDraft[];
  };
  summaries: MigrationTableSummary[];
}

export async function exportAllTables(): Promise<MigrationPayload> {
  const marketDatasets = await db.marketDatasets.toArray();
  const candles = await db.candles.toArray();
  const strategyConfigs = await db.strategyConfigs.toArray();
  const backtestResults = await db.backtestResults.toArray();
  const equityPoints = await db.equityPoints.toArray();
  const visualStrategies = await db.visualStrategies.toArray();
  const strategyVersions = await db.strategyVersions.toArray();
  const strategyDrafts = await db.strategyDrafts.toArray();

  const tables = {
    marketDatasets,
    candles,
    strategyConfigs,
    backtestResults,
    equityPoints,
    visualStrategies,
    strategyVersions,
    strategyDrafts,
  };

  const summaries: MigrationTableSummary[] = Object.entries(tables).map(
    ([name, rows]) => ({ name, count: rows.length }),
  );

  return {
    version: '1.0',
    exportedAt: new Date().toISOString(),
    tables,
    summaries,
  };
}

export async function clearAllTables(): Promise<void> {
  await db.transaction(
    'rw',
    [
      db.marketDatasets, db.candles,
      db.strategyConfigs,
      db.backtestResults, db.equityPoints,
      db.visualStrategies, db.strategyVersions, db.strategyDrafts,
    ],
    async () => {
      await db.marketDatasets.clear();
      await db.candles.clear();
      await db.strategyConfigs.clear();
      await db.backtestResults.clear();
      await db.equityPoints.clear();
      await db.visualStrategies.clear();
      await db.strategyVersions.clear();
      await db.strategyDrafts.clear();
    },
  );
}
