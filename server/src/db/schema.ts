import {
  mysqlTable,
  varchar,
  int,
  double,
  json,
  uniqueIndex,
  index,
} from 'drizzle-orm/mysql-core';

// ─── market_datasets ─────────────────────────────────────────────
export const marketDatasets = mysqlTable('market_datasets', {
  id: varchar('id', { length: 36 }).primaryKey(),
  symbol: varchar('symbol', { length: 20 }).notNull(),
  checksum: varchar('checksum', { length: 64 }).notNull().unique(),
  name: varchar('name', { length: 255 }).notNull(),
  timeframe: varchar('timeframe', { length: 10 }).notNull().default('1d'),
  startTime: varchar('start_time', { length: 10 }).notNull(),
  endTime: varchar('end_time', { length: 10 }).notNull(),
  count: int('count').notNull(),
  sourceFileName: varchar('source_file_name', { length: 255 }),
  createdAt: varchar('created_at', { length: 24 }).notNull(),
  updatedAt: varchar('updated_at', { length: 24 }).notNull(),
}, (table) => ({
  symbolIdx: index('idx_market_datasets_symbol').on(table.symbol),
  checksumIdx: index('idx_market_datasets_checksum').on(table.checksum),
  createdAtIdx: index('idx_market_datasets_created_at').on(table.createdAt),
}));

// ─── candles ─────────────────────────────────────────────────────
export const candles = mysqlTable('candles', {
  id: int('id').autoincrement().primaryKey(),
  datasetId: varchar('dataset_id', { length: 36 }).notNull(),
  time: varchar('time', { length: 10 }).notNull(),
  symbol: varchar('symbol', { length: 20 }).notNull(),
  open: double('open').notNull(),
  high: double('high').notNull(),
  low: double('low').notNull(),
  close: double('close').notNull(),
  change: double('change'),
  changePercent: double('change_percent'),
  volume: double('volume'),
  turnover: double('turnover'),
  constituentCount: double('constituent_count'),
}, (table) => ({
  datasetTimeUnique: uniqueIndex('idx_candles_dataset_time').on(table.datasetId, table.time),
  datasetIdx: index('idx_candles_dataset').on(table.datasetId),
  timeIdx: index('idx_candles_time').on(table.time),
}));

// ─── strategy_configs ────────────────────────────────────────────
export const strategyConfigs = mysqlTable('strategy_configs', {
  id: varchar('id', { length: 36 }).primaryKey(),
  strategyId: varchar('strategy_id', { length: 64 }).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  params: json('params').notNull(),
  createdAt: varchar('created_at', { length: 24 }).notNull(),
  updatedAt: varchar('updated_at', { length: 24 }).notNull(),
}, (table) => ({
  strategyIdIdx: index('idx_sc_strategy_id').on(table.strategyId),
  createdAtIdx: index('idx_sc_created_at').on(table.createdAt),
}));

// ─── backtest_results ────────────────────────────────────────────
export const backtestResults = mysqlTable('backtest_results', {
  id: varchar('id', { length: 36 }).primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  status: varchar('status', { length: 20 }).notNull(),
  datasetSnapshot: json('dataset_snapshot').notNull(),
  strategyId: varchar('strategy_id', { length: 64 }).notNull(),
  strategyVersion: varchar('strategy_version', { length: 32 }).notNull(),
  strategyParams: json('strategy_params').notNull(),
  config: json('config').notNull(),
  startedAt: varchar('started_at', { length: 24 }).notNull(),
  completedAt: varchar('completed_at', { length: 24 }).notNull(),
  metrics: json('metrics').notNull(),
  signals: json('signals').notNull(),
  trades: json('trades').notNull(),
  equityCurve: json('equity_curve').notNull(),
  error: varchar('error', { length: 1000 }),
}, (table) => ({
  statusIdx: index('idx_br_status').on(table.status),
  startedAtIdx: index('idx_br_started_at').on(table.startedAt),
}));

// ─── equity_points ───────────────────────────────────────────────
export const equityPoints = mysqlTable('equity_points', {
  id: int('id').autoincrement().primaryKey(),
  resultId: varchar('result_id', { length: 36 }).notNull(),
  time: varchar('time', { length: 10 }).notNull(),
  cash: double('cash').notNull(),
  marketValue: double('market_value').notNull(),
  equity: double('equity').notNull(),
  drawdown: double('drawdown').notNull(),
  positionQuantity: double('position_quantity').notNull(),
  contributedCapital: double('contributed_capital'),
}, (table) => ({
  resultTimeUnique: uniqueIndex('idx_ep_result_time').on(table.resultId, table.time),
  resultIdx: index('idx_ep_result').on(table.resultId),
}));

// ─── visual_strategies ───────────────────────────────────────────
export const visualStrategies = mysqlTable('visual_strategies', {
  id: varchar('id', { length: 36 }).primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  document: json('document').notNull(),
  status: varchar('status', { length: 20 }).notNull(),
  createdAt: varchar('created_at', { length: 24 }).notNull(),
  updatedAt: varchar('updated_at', { length: 24 }).notNull(),
}, (table) => ({
  statusIdx: index('idx_vs_status').on(table.status),
  updatedAtIdx: index('idx_vs_updated_at').on(table.updatedAt),
}));

// ─── strategy_versions ───────────────────────────────────────────
export const strategyVersions = mysqlTable('strategy_versions', {
  id: varchar('id', { length: 36 }).primaryKey(),
  strategyId: varchar('strategy_id', { length: 36 }).notNull(),
  version: int('version').notNull(),
  document: json('document').notNull(),
  createdAt: varchar('created_at', { length: 24 }).notNull(),
}, (table) => ({
  strategyVersionUnique: uniqueIndex('idx_sv_strategy_version').on(table.strategyId, table.version),
  strategyIdx: index('idx_sv_strategy').on(table.strategyId),
}));

// ─── strategy_drafts ─────────────────────────────────────────────
export const strategyDrafts = mysqlTable('strategy_drafts', {
  id: varchar('id', { length: 36 }).primaryKey(),
  strategyId: varchar('strategy_id', { length: 36 }).notNull(),
  document: json('document').notNull(),
  updatedAt: varchar('updated_at', { length: 24 }).notNull(),
}, (table) => ({
  strategyIdIdx: index('idx_sd_strategy_id').on(table.strategyId),
}));
