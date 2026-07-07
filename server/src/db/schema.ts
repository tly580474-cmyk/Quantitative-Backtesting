import {
  mysqlTable,
  varchar,
  int,
  double,
  json,
  uniqueIndex,
  index,
  date,
  datetime,
  bigint,
  primaryKey,
} from 'drizzle-orm/mysql-core';

// ─── market_datasets ─────────────────────────────────────────────
export const marketDatasets = mysqlTable('market_datasets', {
  id: varchar('id', { length: 36 }).primaryKey(),
  symbol: varchar('symbol', { length: 20 }).notNull(),
  assetType: varchar('asset_type', { length: 10 }).notNull().default('stock'),
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
  turnoverRatePct: double('turnover_rate_pct'),
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

// ─── Phase 5: instruments ─────────────────────────────────────────
export const instruments = mysqlTable('instruments', {
  id: varchar('id', { length: 36 }).primaryKey(),
  instrumentKey: int('instrument_key', { unsigned: true }).autoincrement().notNull(),
  market: varchar('market', { length: 16 }).notNull(),
  symbol: varchar('symbol', { length: 20 }).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  industry: varchar('industry', { length: 128 }),
  type: varchar('type', { length: 32 }).notNull(),
  listDate: varchar('list_date', { length: 10 }),
  delistDate: varchar('delist_date', { length: 10 }),
  status: varchar('status', { length: 16 }).notNull().default('active'),
  createdAt: varchar('created_at', { length: 24 }).notNull(),
  updatedAt: varchar('updated_at', { length: 24 }).notNull(),
}, (table) => ({
  instrumentKeyUnique: uniqueIndex('idx_inst_instrument_key').on(table.instrumentKey),
  marketSymbolTypeUnique: uniqueIndex('idx_inst_market_symbol_type').on(table.market, table.symbol, table.type),
  statusIdx: index('idx_inst_status').on(table.status),
  symbolIdx: index('idx_inst_symbol').on(table.symbol),
}));

// ─── Phase 5: provider_symbol_mappings ────────────────────────────
export const providerSymbolMappings = mysqlTable('provider_symbol_mappings', {
  id: varchar('id', { length: 36 }).primaryKey(),
  providerId: varchar('provider_id', { length: 64 }).notNull(),
  instrumentId: varchar('instrument_id', { length: 36 }).notNull(),
  providerSymbol: varchar('provider_symbol', { length: 64 }).notNull(),
}, (table) => ({
  providerInstUnique: uniqueIndex('idx_psm_provider_inst').on(table.providerId, table.instrumentId),
  providerSymbolIdx: index('idx_psm_provider_symbol').on(table.providerId, table.providerSymbol),
  instrumentIdx: index('idx_psm_instrument').on(table.instrumentId),
}));

// ─── Phase 5: trading_calendar ────────────────────────────────────
export const tradingCalendar = mysqlTable('trading_calendar', {
  id: varchar('id', { length: 36 }).primaryKey(),
  market: varchar('market', { length: 16 }).notNull(),
  tradeDate: varchar('trade_date', { length: 10 }).notNull(),
  isOpen: int('is_open').notNull().default(1),
  sessionMetadata: json('session_metadata'),
}, (table) => ({
  marketDateUnique: uniqueIndex('idx_tcal_market_date').on(table.market, table.tradeDate),
  dateIdx: index('idx_tcal_date').on(table.tradeDate),
}));

// ─── Phase 5: daily_candles ───────────────────────────────────────
export const dailyCandles = mysqlTable('daily_candles', {
  id: varchar('id', { length: 36 }).primaryKey(),
  instrumentId: varchar('instrument_id', { length: 36 }).notNull(),
  tradeDate: varchar('trade_date', { length: 10 }).notNull(),
  open: double('open').notNull(),
  high: double('high').notNull(),
  low: double('low').notNull(),
  close: double('close').notNull(),
  volume: double('volume').notNull(),
  turnover: double('turnover'),
  turnoverRatePct: double('turnover_rate_pct'),
  sourceId: varchar('source_id', { length: 64 }).notNull(),
  sourceVersion: varchar('source_version', { length: 32 }).notNull().default('1'),
  fetchedAt: varchar('fetched_at', { length: 24 }).notNull(),
}, (table) => ({
  instDateSourceUnique: uniqueIndex('idx_dc_inst_date_src').on(table.instrumentId, table.tradeDate, table.sourceId),
  instrumentIdx: index('idx_dc_instrument').on(table.instrumentId),
  dateIdx: index('idx_dc_date').on(table.tradeDate),
  sourceIdx: index('idx_dc_source').on(table.sourceId),
}));

// ─── Phase 5: adjustment_factors ──────────────────────────────────
export const adjustmentFactors = mysqlTable('adjustment_factors', {
  id: varchar('id', { length: 36 }).primaryKey(),
  instrumentId: varchar('instrument_id', { length: 36 }).notNull(),
  tradeDate: varchar('trade_date', { length: 10 }).notNull(),
  factor: double('factor').notNull(),
  sourceId: varchar('source_id', { length: 64 }).notNull(),
  fetchedAt: varchar('fetched_at', { length: 24 }).notNull(),
}, (table) => ({
  instDateSourceUnique: uniqueIndex('idx_af_inst_date_src').on(table.instrumentId, table.tradeDate, table.sourceId),
  instrumentIdx: index('idx_af_instrument').on(table.instrumentId),
  dateIdx: index('idx_af_date').on(table.tradeDate),
}));

// ─── Phase 5: market_data_versions ────────────────────────────────
export const marketDataVersions = mysqlTable('market_data_versions', {
  id: varchar('id', { length: 36 }).primaryKey(),
  instrumentId: varchar('instrument_id', { length: 36 }).notNull(),
  startDate: varchar('start_date', { length: 10 }).notNull(),
  endDate: varchar('end_date', { length: 10 }).notNull(),
  checksum: varchar('checksum', { length: 64 }).notNull(),
  adjustmentVersion: varchar('adjustment_version', { length: 16 }).notNull().default('1'),
  qualityStatus: varchar('quality_status', { length: 16 }).notNull().default('pass'),
  recordCount: int('record_count').notNull().default(0),
  createdAt: varchar('created_at', { length: 24 }).notNull(),
}, (table) => ({
  instrumentIdx: index('idx_mdv_instrument').on(table.instrumentId),
  qualityIdx: index('idx_mdv_quality').on(table.qualityStatus),
  createdIdx: index('idx_mdv_created').on(table.createdAt),
}));

// ─── Phase 5: sync_jobs ───────────────────────────────────────────
export const syncJobs = mysqlTable('sync_jobs', {
  id: varchar('id', { length: 36 }).primaryKey(),
  jobType: varchar('job_type', { length: 32 }).notNull(),
  status: varchar('status', { length: 16 }).notNull().default('pending'),
  providerId: varchar('provider_id', { length: 64 }).notNull(),
  requestSnapshot: json('request_snapshot').notNull(),
  totalItems: int('total_items').notNull().default(0),
  completedItems: int('completed_items').notNull().default(0),
  failedItems: int('failed_items').notNull().default(0),
  startedAt: varchar('started_at', { length: 24 }),
  finishedAt: varchar('finished_at', { length: 24 }),
  createdAt: varchar('created_at', { length: 24 }).notNull(),
}, (table) => ({
  statusCreatedIdx: index('idx_sj_status_created').on(table.status, table.createdAt),
  typeIdx: index('idx_sj_type').on(table.jobType),
}));

// ─── Phase 5: sync_job_items ──────────────────────────────────────
export const syncJobItems = mysqlTable('sync_job_items', {
  id: varchar('id', { length: 36 }).primaryKey(),
  jobId: varchar('job_id', { length: 36 }).notNull(),
  instrumentId: varchar('instrument_id', { length: 36 }).notNull(),
  status: varchar('status', { length: 16 }).notNull().default('pending'),
  attempts: int('attempts').notNull().default(0),
  errorCode: varchar('error_code', { length: 32 }),
  errorMessage: varchar('error_message', { length: 1000 }),
}, (table) => ({
  jobIdx: index('idx_sji_job').on(table.jobId),
  statusIdx: index('idx_sji_status').on(table.status),
}));

// ─── Phase 5: data_quality_issues ─────────────────────────────────
export const dataQualityIssues = mysqlTable('data_quality_issues', {
  id: varchar('id', { length: 36 }).primaryKey(),
  instrumentId: varchar('instrument_id', { length: 36 }).notNull(),
  tradeDate: varchar('trade_date', { length: 10 }).notNull(),
  ruleCode: varchar('rule_code', { length: 64 }).notNull(),
  severity: varchar('severity', { length: 16 }).notNull(),
  status: varchar('status', { length: 16 }).notNull().default('open'),
  details: json('details'),
  detectedAt: varchar('detected_at', { length: 24 }).notNull(),
  resolvedAt: varchar('resolved_at', { length: 24 }),
}, (table) => ({
  statusSeverityIdx: index('idx_dqi_status_severity').on(table.status, table.severity, table.detectedAt),
  instrumentIdx: index('idx_dqi_instrument').on(table.instrumentId),
  dateIdx: index('idx_dqi_date').on(table.tradeDate),
}));

// ─── Phase 5.5: compact authoritative history store ───────────────
export const dailyBarsV2 = mysqlTable('daily_bars_v2', {
  instrumentKey: int('instrument_key', { unsigned: true }).notNull(),
  tradeDate: date('trade_date', { mode: 'string' }).notNull(),
  open: double('open').notNull(),
  high: double('high').notNull(),
  low: double('low').notNull(),
  close: double('close').notNull(),
  previousClose: double('previous_close'),
  volume: bigint('volume', { mode: 'number', unsigned: true }),
  amount: double('amount'),
  turnoverRatePct: double('turnover_rate_pct'),
  sourceKey: int('source_key', { unsigned: true }).notNull().default(1),
  sourceVersion: varchar('source_version', { length: 64 }).notNull(),
  fetchedAt: datetime('fetched_at', { mode: 'string' }).notNull(),
  isFinal: int('is_final', { unsigned: true }).notNull().default(1),
}, (table) => ({
  pk: primaryKey({ columns: [table.instrumentKey, table.tradeDate] }),
  tradeDateIdx: index('idx_dbv2_trade_date_instrument').on(
    table.tradeDate,
    table.instrumentKey,
    table.close,
    table.volume,
  ),
}));

export const dailyStockMetrics = mysqlTable('daily_stock_metrics', {
  instrumentKey: int('instrument_key', { unsigned: true }).notNull(),
  tradeDate: date('trade_date', { mode: 'string' }).notNull(),
  totalShares: bigint('total_shares', { mode: 'number', unsigned: true }),
  floatShares: bigint('float_shares', { mode: 'number', unsigned: true }),
  totalMarketCap: double('total_market_cap'),
  floatMarketCap: double('float_market_cap'),
  peTtm: double('pe_ttm'),
  pb: double('pb'),
  psTtm: double('ps_ttm'),
  volumeRatio: double('volume_ratio'),
  isSt: int('is_st', { unsigned: true }).notNull().default(0),
  isLimitUp: int('is_limit_up', { unsigned: true }).notNull().default(0),
}, (table) => ({
  pk: primaryKey({ columns: [table.instrumentKey, table.tradeDate] }),
  tradeDateIdx: index('idx_dsm_trade_date_instrument').on(table.tradeDate, table.instrumentKey),
}));

export const adjustmentFactorsV2 = mysqlTable('adjustment_factors_v2', {
  instrumentKey: int('instrument_key', { unsigned: true }).notNull(),
  effectiveDate: date('effective_date', { mode: 'string' }).notNull(),
  factorVersion: varchar('factor_version', { length: 32 }).notNull(),
  factor: double('factor').notNull(),
  priceOffset: double('price_offset').notNull().default(0),
  sourceKey: int('source_key', { unsigned: true }).notNull().default(1),
  sourceBatchId: varchar('source_batch_id', { length: 36 }).notNull(),
}, (table) => ({
  pk: primaryKey({
    columns: [table.instrumentKey, table.effectiveDate, table.factorVersion],
  }),
}));

export const adjustmentFactorPublications = mysqlTable('adjustment_factor_publications', {
  instrumentKey: int('instrument_key', { unsigned: true }).primaryKey(),
  factorVersion: varchar('factor_version', { length: 32 }).notNull(),
  sourceBatchId: varchar('source_batch_id', { length: 36 }).notNull(),
  sourceFingerprint: varchar('source_fingerprint', { length: 64 }).notNull(),
  lastCheckedDate: date('last_checked_date', { mode: 'string' }).notNull(),
  publishedAt: datetime('published_at', { mode: 'string' }).notNull(),
});

export const corporateActions = mysqlTable('corporate_actions', {
  id: varchar('id', { length: 36 }).primaryKey(),
  instrumentKey: int('instrument_key', { unsigned: true }).notNull(),
  exDate: date('ex_date', { mode: 'string' }).notNull(),
  actionType: varchar('action_type', { length: 32 }).notNull().default('unknown'),
  previousClose: double('previous_close'),
  exReferencePrice: double('ex_reference_price'),
  sourceKey: int('source_key', { unsigned: true }).notNull().default(1),
  sourceFingerprint: varchar('source_fingerprint', { length: 64 }).notNull(),
  status: varchar('status', { length: 16 }).notNull().default('confirmed'),
  detectedAt: datetime('detected_at', { mode: 'string' }).notNull(),
}, (table) => ({
  instrumentDateUnique: uniqueIndex('idx_ca_instrument_date').on(
    table.instrumentKey,
    table.exDate,
  ),
  exDateIdx: index('idx_ca_ex_date').on(table.exDate),
}));

export const adjustedBarOverrides = mysqlTable('adjusted_bar_overrides', {
  instrumentKey: int('instrument_key', { unsigned: true }).notNull(),
  tradeDate: date('trade_date', { mode: 'string' }).notNull(),
  adjustmentMode: varchar('adjustment_mode', { length: 4 }).notNull(),
  open: double('open').notNull(),
  high: double('high').notNull(),
  low: double('low').notNull(),
  close: double('close').notNull(),
  reason: varchar('reason', { length: 64 }).notNull(),
  sourceBatchId: varchar('source_batch_id', { length: 36 }).notNull(),
}, (table) => ({
  pk: primaryKey({
    columns: [table.instrumentKey, table.tradeDate, table.adjustmentMode],
  }),
}));

export const dataImportBatches = mysqlTable('data_import_batches', {
  id: varchar('id', { length: 36 }).primaryKey(),
  sourceRoot: varchar('source_root', { length: 1024 }).notNull(),
  sourceSnapshot: varchar('source_snapshot', { length: 64 }).notNull(),
  status: varchar('status', { length: 16 }).notNull().default('pending'),
  totalFiles: int('total_files').notNull().default(0),
  completedFiles: int('completed_files').notNull().default(0),
  failedFiles: int('failed_files').notNull().default(0),
  totalRows: bigint('total_rows', { mode: 'number', unsigned: true }).notNull().default(0),
  importedRows: bigint('imported_rows', { mode: 'number', unsigned: true }).notNull().default(0),
  startedAt: datetime('started_at', { mode: 'string' }),
  finishedAt: datetime('finished_at', { mode: 'string' }),
  publishedAt: datetime('published_at', { mode: 'string' }),
}, (table) => ({
  statusIdx: index('idx_dib_status_started').on(table.status, table.startedAt),
}));

export const dataImportFiles = mysqlTable('data_import_files', {
  batchId: varchar('batch_id', { length: 36 }).notNull(),
  relativePath: varchar('relative_path', { length: 512 }).notNull(),
  adjustmentMode: varchar('adjustment_mode', { length: 4 }).notNull(),
  checksum: varchar('checksum', { length: 64 }).notNull(),
  expectedRows: int('expected_rows', { unsigned: true }).notNull().default(0),
  importedRows: int('imported_rows', { unsigned: true }).notNull().default(0),
  minDate: date('min_date', { mode: 'string' }),
  maxDate: date('max_date', { mode: 'string' }),
  status: varchar('status', { length: 16 }).notNull().default('pending'),
  errorMessage: varchar('error_message', { length: 1000 }),
  startedAt: datetime('started_at', { mode: 'string' }),
  finishedAt: datetime('finished_at', { mode: 'string' }),
}, (table) => ({
  pk: primaryKey({ columns: [table.batchId, table.relativePath] }),
  statusIdx: index('idx_dif_batch_status').on(table.batchId, table.status),
  checksumIdx: index('idx_dif_checksum').on(table.checksum),
}));

// ─── Phase 6: factor research metadata ───────────────────────────
export const factorDefinitions = mysqlTable('factor_definitions', {
  id: varchar('id', { length: 64 }).primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  description: varchar('description', { length: 1000 }).notNull(),
  status: varchar('status', { length: 16 }).notNull().default('active'),
  createdAt: varchar('created_at', { length: 24 }).notNull(),
  updatedAt: varchar('updated_at', { length: 24 }).notNull(),
}, (table) => ({
  statusIdx: index('idx_fd_status').on(table.status),
  updatedAtIdx: index('idx_fd_updated_at').on(table.updatedAt),
}));

export const factorVersions = mysqlTable('factor_versions', {
  id: varchar('id', { length: 96 }).primaryKey(),
  factorId: varchar('factor_id', { length: 64 }).notNull(),
  version: int('version').notNull(),
  expression: json('expression').notNull(),
  direction: varchar('direction', { length: 24 }).notNull(),
  dependencies: json('dependencies').notNull(),
  warmupDays: int('warmup_days').notNull().default(0),
  checksum: varchar('checksum', { length: 64 }).notNull(),
  publishedAt: varchar('published_at', { length: 24 }).notNull(),
}, (table) => ({
  factorVersionUnique: uniqueIndex('idx_fv_factor_version').on(table.factorId, table.version),
  checksumIdx: index('idx_fv_checksum').on(table.checksum),
}));

export const factorRuns = mysqlTable('factor_runs', {
  id: varchar('id', { length: 36 }).primaryKey(),
  factorVersionId: varchar('factor_version_id', { length: 96 }).notNull(),
  snapshotId: varchar('snapshot_id', { length: 128 }).notNull(),
  universeId: varchar('universe_id', { length: 64 }).notNull().default('builtin-all-a'),
  status: varchar('status', { length: 16 }).notNull(),
  dateStart: varchar('date_start', { length: 10 }).notNull(),
  dateEnd: varchar('date_end', { length: 10 }).notNull(),
  preprocessingConfig: json('preprocessing_config').notNull(),
  labelConfig: json('label_config').notNull(),
  runConfig: json('run_config').notNull(),
  totalDates: int('total_dates').notNull().default(0),
  completedDates: int('completed_dates').notNull().default(0),
  artifactUri: varchar('artifact_uri', { length: 1024 }),
  errorMessage: varchar('error_message', { length: 1000 }),
  createdAt: varchar('created_at', { length: 24 }).notNull(),
  startedAt: varchar('started_at', { length: 24 }),
  finishedAt: varchar('finished_at', { length: 24 }),
}, (table) => ({
  factorStatusIdx: index('idx_fr_factor_status').on(table.factorVersionId, table.status),
  snapshotIdx: index('idx_fr_snapshot').on(table.snapshotId),
  createdAtIdx: index('idx_fr_created_at').on(table.createdAt),
}));

export const factorReports = mysqlTable('factor_reports', {
  id: varchar('id', { length: 36 }).primaryKey(),
  runId: varchar('run_id', { length: 36 }).notNull(),
  summaryMetrics: json('summary_metrics').notNull(),
  reportUri: varchar('report_uri', { length: 1024 }).notNull(),
  createdAt: varchar('created_at', { length: 24 }).notNull(),
}, (table) => ({
  runIdx: index('idx_frep_run').on(table.runId),
  createdAtIdx: index('idx_frep_created_at').on(table.createdAt),
}));
