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
  text,
  decimal,
} from 'drizzle-orm/mysql-core';
import { sql } from 'drizzle-orm';

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

export const indexConstituentSnapshots = mysqlTable('index_constituent_snapshots', {
  snapshotId: varchar('snapshot_id', { length: 36 }).primaryKey(),
  indexCode: varchar('index_code', { length: 20 }).notNull(),
  indexName: varchar('index_name', { length: 255 }).notNull(),
  constituentDate: date('constituent_date', { mode: 'string' }).notNull(),
  weightDate: date('weight_date', { mode: 'string' }),
  sourceKey: varchar('source_key', { length: 64 }).notNull(),
  sourceChecksum: varchar('source_checksum', { length: 64 }).notNull(),
  sourceUrl: varchar('source_url', { length: 1024 }),
  sourceCapturedAt: datetime('source_captured_at', { mode: 'string' }),
  sourceFileChecksum: varchar('source_file_checksum', { length: 64 }),
  weightMethod: varchar('weight_method', { length: 32 }).notNull().default('official'),
  anchorSnapshotId: varchar('anchor_snapshot_id', { length: 36 }),
  validationSnapshotId: varchar('validation_snapshot_id', { length: 36 }),
  validationHalfL1Pct: double('validation_half_l1_pct'),
  fetchedAt: datetime('fetched_at', { mode: 'string' }).notNull(),
  memberCount: int('member_count', { unsigned: true }).notNull(),
  weightSumPct: double('weight_sum_pct'),
  status: varchar('status', { length: 16 }).notNull().default('published'),
}, (table) => ({
  versionUnique: uniqueIndex('idx_ics_version').on(
    table.indexCode,
    table.constituentDate,
    table.sourceKey,
    table.sourceChecksum,
  ),
  indexDateIdx: index('idx_ics_index_date').on(table.indexCode, table.constituentDate),
}));

export const indexConstituentMembers = mysqlTable('index_constituent_members', {
  snapshotId: varchar('snapshot_id', { length: 36 }).notNull(),
  constituentCode: varchar('constituent_code', { length: 20 }).notNull(),
  instrumentKey: int('instrument_key', { unsigned: true }),
  constituentName: varchar('constituent_name', { length: 255 }).notNull(),
  constituentNameEn: varchar('constituent_name_en', { length: 255 }),
  exchange: varchar('exchange', { length: 64 }),
  exchangeEn: varchar('exchange_en', { length: 128 }),
  weightPct: double('weight_pct'),
  rawCode: varchar('raw_code', { length: 32 }).notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.snapshotId, table.constituentCode] }),
  instrumentIdx: index('idx_icm_instrument').on(table.instrumentKey),
  codeIdx: index('idx_icm_code').on(table.constituentCode),
}));

export const dividendEvents = mysqlTable('dividend_events', {
  eventId: varchar('event_id', { length: 36 }).primaryKey(),
  instrumentKey: int('instrument_key', { unsigned: true }).notNull(),
  reportPeriod: date('report_period', { mode: 'string' }).notNull(),
  disclosureDate: date('disclosure_date', { mode: 'string' }),
  announcementDate: date('announcement_date', { mode: 'string' }),
  recordDate: date('record_date', { mode: 'string' }),
  exDate: date('ex_date', { mode: 'string' }),
  latestAnnouncementDate: date('latest_announcement_date', { mode: 'string' }),
  cashDividendPerShare: double('cash_dividend_per_share'),
  bonusSharePerShare: double('bonus_share_per_share'),
  transferSharePerShare: double('transfer_share_per_share'),
  dividendYieldRaw: double('dividend_yield_raw'),
  planStatus: varchar('plan_status', { length: 32 }),
  rawPlan: varchar('raw_plan', { length: 1000 }),
  sourceKey: varchar('source_key', { length: 64 }).notNull(),
  sourceFingerprint: varchar('source_fingerprint', { length: 64 }).notNull(),
  fetchedAt: datetime('fetched_at', { mode: 'string' }).notNull(),
}, (table) => ({
  sourceFingerprintUnique: uniqueIndex('idx_de_source_fingerprint').on(table.sourceFingerprint),
  instrumentExDateIdx: index('idx_de_instrument_ex_date').on(table.instrumentKey, table.exDate),
  reportPeriodIdx: index('idx_de_report_period').on(table.reportPeriod),
}));

export const financialReports = mysqlTable('financial_reports', {
  instrumentKey: int('instrument_key', { unsigned: true }).notNull(),
  reportPeriod: date('report_period', { mode: 'string' }).notNull(),
  announcementDate: date('announcement_date', { mode: 'string' }).notNull(),
  reportType: varchar('report_type', { length: 16 }).notNull().default('quarterly'),
  fiscalYear: int('fiscal_year', { unsigned: true }).notNull(),
  fiscalQuarter: int('fiscal_quarter', { unsigned: true }).notNull(),
  updateFlag: int('update_flag', { unsigned: true }).notNull().default(0),
  totalRevenue: double('total_revenue'),
  revenue: double('revenue'),
  operatingCost: double('operating_cost'),
  totalOperatingCost: double('total_operating_cost'),
  operatingProfit: double('operating_profit'),
  totalProfit: double('total_profit'),
  incomeTax: double('income_tax'),
  netProfit: double('net_profit'),
  netProfitParent: double('net_profit_parent'),
  totalAssets: double('total_assets'),
  totalLiabilities: double('total_liabilities'),
  totalEquity: double('total_equity'),
  equityParent: double('equity_parent'),
  totalCurrentAssets: double('total_current_assets'),
  totalCurrentLiabilities: double('total_current_liabilities'),
  cashAndEquivalents: double('cash_and_equivalents'),
  accountsReceivable: double('accounts_receivable'),
  inventory: double('inventory'),
  goodwill: double('goodwill'),
  shortTermBorrowings: double('short_term_borrowings'),
  longTermBorrowings: double('long_term_borrowings'),
  bondsPayable: double('bonds_payable'),
  netOperatingCashFlow: double('net_operating_cash_flow'),
  netInvestingCashFlow: double('net_investing_cash_flow'),
  netFinancingCashFlow: double('net_financing_cash_flow'),
  capitalExpenditure: double('capital_expenditure'),
  freeCashFlow: double('free_cash_flow'),
  eps: double('eps'),
  dilutedEps: double('diluted_eps'),
  bps: double('bps'),
  revenuePerShare: double('revenue_per_share'),
  operatingCashFlowPerShare: double('operating_cash_flow_per_share'),
  roePct: double('roe_pct'),
  roeWeightedPct: double('roe_weighted_pct'),
  roeDilutedPct: double('roe_diluted_pct'),
  roeCalculatedPct: double('roe_calculated_pct'),
  roeCalculationMethod: varchar('roe_calculation_method', { length: 64 }),
  roaPct: double('roa_pct'),
  grossMarginPct: double('gross_margin_pct'),
  netMarginPct: double('net_margin_pct'),
  debtToAssetsPct: double('debt_to_assets_pct'),
  currentRatio: double('current_ratio'),
  quickRatio: double('quick_ratio'),
  assetTurnover: double('asset_turnover'),
  inventoryTurnover: double('inventory_turnover'),
  receivablesTurnover: double('receivables_turnover'),
  operatingCashFlowToRevenuePct: double('operating_cash_flow_to_revenue_pct'),
  revenueYoyPct: double('revenue_yoy_pct'),
  netProfitYoyPct: double('net_profit_yoy_pct'),
  sourceKey: varchar('source_key', { length: 32 }).notNull(),
  sourceVersion: varchar('source_version', { length: 64 }).notNull(),
  sourceFingerprint: varchar('source_fingerprint', { length: 64 }).notNull(),
  fetchedAt: datetime('fetched_at', { mode: 'string' }).notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.instrumentKey, table.reportPeriod, table.announcementDate] }),
  fingerprintUnique: uniqueIndex('idx_fr_source_fingerprint').on(table.sourceFingerprint),
  periodIdx: index('idx_fr_period').on(table.reportPeriod),
  announcementIdx: index('idx_fr_announcement').on(table.announcementDate),
  instrumentAnnouncementIdx: index('idx_fr_instrument_announcement')
    .on(table.instrumentKey, table.announcementDate),
  sourceFetchedIdx: index('idx_fr_source_fetched').on(table.sourceKey, table.fetchedAt),
}));

export const dragonTigerBillboards = mysqlTable('dragon_tiger_billboards', {
  id: bigint('id', { mode: 'number', unsigned: true }).autoincrement().primaryKey(),
  tradeId: varchar('trade_id', { length: 64 }).notNull(),
  tradeDate: date('trade_date', { mode: 'string' }).notNull(),
  securityCode: varchar('security_code', { length: 10 }).notNull(),
  securityName: varchar('security_name', { length: 64 }).notNull(),
  exchange: varchar('exchange', { length: 4 }).notNull(),
  explanation: varchar('explanation', { length: 500 }),
  changeType: varchar('change_type', { length: 32 }),
  netBuyAmt: double('net_buy_amt'),
  buyAmt: double('buy_amt'),
  sellAmt: double('sell_amt'),
  billboardDealAmt: double('billboard_deal_amt'),
  closePrice: double('close_price'),
  changePct: double('change_pct'),
  turnoverRate: double('turnover_rate'),
  reasonCodes: json('reason_codes'),
  sourceKey: varchar('source_key', { length: 32 }).notNull().default('eastmoney'),
  sourceFingerprint: varchar('source_fingerprint', { length: 64 }).notNull(),
  fetchedAt: datetime('fetched_at', { mode: 'string' }).notNull(),
}, (table) => ({
  fingerprintUnique: uniqueIndex('idx_dtb_fingerprint').on(table.sourceFingerprint),
  sourceTradeUnique: uniqueIndex('idx_dtb_source_trade').on(table.sourceKey, table.tradeId),
  dateIdx: index('idx_dtb_date').on(table.tradeDate),
  codeDateIdx: index('idx_dtb_code_date').on(table.securityCode, table.tradeDate),
  netBuyIdx: index('idx_dtb_net_buy').on(table.tradeDate, table.netBuyAmt),
}));

export const dragonTigerSeats = mysqlTable('dragon_tiger_seats', {
  id: bigint('id', { mode: 'number', unsigned: true }).autoincrement().primaryKey(),
  billboardId: bigint('billboard_id', { mode: 'number', unsigned: true }).notNull()
    .references(() => dragonTigerBillboards.id, { onDelete: 'cascade' }),
  tradeId: varchar('trade_id', { length: 64 }).notNull(),
  tradeDate: date('trade_date', { mode: 'string' }).notNull(),
  securityCode: varchar('security_code', { length: 10 }).notNull(),
  seatName: varchar('seat_name', { length: 255 }).notNull(),
  seatSide: varchar('seat_side', { length: 8 }).notNull(),
  operateDeptCode: varchar('operate_dept_code', { length: 64 }),
  buyAmt: double('buy_amt'),
  sellAmt: double('sell_amt'),
  netAmt: double('net_amt'),
  rank: int('seat_rank', { unsigned: true }).notNull(),
  isInstitutional: int('is_institutional').notNull().default(0),
  sourceKey: varchar('source_key', { length: 32 }).notNull().default('eastmoney'),
  sourceFingerprint: varchar('source_fingerprint', { length: 64 }).notNull(),
  fetchedAt: datetime('fetched_at', { mode: 'string' }).notNull(),
}, (table) => ({
  fingerprintUnique: uniqueIndex('idx_dts_fingerprint').on(table.sourceFingerprint),
  billboardIdx: index('idx_dts_billboard').on(table.billboardId),
  dateCodeIdx: index('idx_dts_date_code').on(table.tradeDate, table.securityCode),
  seatIdx: index('idx_dts_seat').on(table.seatName),
  dateSeatIdx: index('idx_dts_date_seat').on(table.tradeDate, table.seatName),
}));

export const marketNews = mysqlTable('market_news', {
  id: bigint('id', { mode: 'number', unsigned: true }).autoincrement().primaryKey(),
  newsId: varchar('news_id', { length: 128 }).notNull(),
  sourceKey: varchar('source_key', { length: 32 }).notNull(),
  sourceName: varchar('source_name', { length: 64 }).notNull(),
  sourceTier: varchar('source_tier', { length: 16 }).notNull(),
  contentType: varchar('content_type', { length: 16 }).notNull(),
  sourceUrl: varchar('source_url', { length: 1024 }),
  title: varchar('title', { length: 500 }).notNull(),
  summary: text('summary'),
  content: text('content'),
  publishedAt: datetime('published_at', { mode: 'string' }).notNull(),
  securityCode: varchar('security_code', { length: 10 }),
  securityName: varchar('security_name', { length: 64 }),
  industry: varchar('industry', { length: 64 }),
  tags: json('tags'),
  raw: json('raw'),
  canonicalHash: varchar('canonical_hash', { length: 64 }).notNull(),
  fetchedAt: datetime('fetched_at', { mode: 'string' }).notNull(),
}, (table) => ({
  newsSourceUnique: uniqueIndex('idx_mn_news_source').on(table.newsId, table.sourceKey),
  canonicalIdx: index('idx_mn_canonical').on(table.canonicalHash, table.publishedAt),
  publishedIdx: index('idx_mn_published').on(table.publishedAt, table.id),
  tierIdx: index('idx_mn_tier').on(table.sourceTier, table.publishedAt),
  sourceIdx: index('idx_mn_source').on(table.sourceKey, table.publishedAt),
  codeIdx: index('idx_mn_code').on(table.securityCode, table.publishedAt),
}));

export const marketDataCollectorRuns = mysqlTable('market_data_collector_runs', {
  runKey: varchar('run_key', { length: 191 }).primaryKey(),
  jobType: varchar('job_type', { length: 32 }).notNull(),
  status: varchar('status', { length: 16 }).notNull(),
  attempts: int('attempts', { unsigned: true }).notNull().default(1),
  startedAt: datetime('started_at', { mode: 'string' }).notNull(),
  finishedAt: datetime('finished_at', { mode: 'string' }),
  errorMessage: varchar('error_message', { length: 1000 }),
  details: json('details'),
}, (table) => ({
  jobStartedIdx: index('idx_mdcr_job_started').on(table.jobType, table.startedAt),
  statusStartedIdx: index('idx_mdcr_status_started').on(table.status, table.startedAt),
}));

export const referenceDataBackfillItems = mysqlTable('reference_data_backfill_items', {
  taskKey: varchar('task_key', { length: 64 }).notNull(),
  instrumentKey: int('instrument_key', { unsigned: true }).notNull(),
  status: varchar('status', { length: 16 }).notNull().default('pending'),
  attempts: int('attempts', { unsigned: true }).notNull().default(0),
  lastError: varchar('last_error', { length: 1000 }),
  updatedAt: datetime('updated_at', { mode: 'string' }).notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.taskKey, table.instrumentKey] }),
  taskStatusIdx: index('idx_rdbi_task_status').on(table.taskKey, table.status, table.instrumentKey),
}));

export const swIndustryDefinitions = mysqlTable('sw_industry_definitions', {
  taxonomyKey: varchar('taxonomy_key', { length: 32 }).notNull(),
  industryCode: varchar('industry_code', { length: 12 }).notNull(),
  industryName: varchar('industry_name', { length: 128 }).notNull(),
  industryLevel: int('industry_level', { unsigned: true }).notNull(),
  parentCode: varchar('parent_code', { length: 12 }),
  indexCode: varchar('index_code', { length: 12 }),
  sourceKey: varchar('source_key', { length: 64 }).notNull(),
  sourceVersion: varchar('source_version', { length: 64 }).notNull(),
  fetchedAt: datetime('fetched_at', { mode: 'string' }).notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.taxonomyKey, table.industryCode] }),
  taxonomyIndexUnique: uniqueIndex('idx_sid_taxonomy_index').on(table.taxonomyKey, table.indexCode),
  parentIdx: index('idx_sid_parent').on(table.taxonomyKey, table.parentCode),
  levelIdx: index('idx_sid_level').on(table.taxonomyKey, table.industryLevel),
}));

export const swIndustryMemberships = mysqlTable('sw_industry_memberships', {
  taxonomyKey: varchar('taxonomy_key', { length: 32 }).notNull(),
  symbol: varchar('symbol', { length: 20 }).notNull(),
  instrumentKey: int('instrument_key', { unsigned: true }),
  level1Code: varchar('level1_code', { length: 12 }).notNull(),
  level2Code: varchar('level2_code', { length: 12 }).notNull(),
  level3Code: varchar('level3_code', { length: 12 }).notNull(),
  effectiveFrom: datetime('effective_from', { mode: 'string' }).notNull(),
  effectiveTo: datetime('effective_to', { mode: 'string' }),
  sourceKey: varchar('source_key', { length: 64 }).notNull(),
  sourceVersion: varchar('source_version', { length: 64 }).notNull(),
  sourceUpdatedAt: datetime('source_updated_at', { mode: 'string' }),
  fetchedAt: datetime('fetched_at', { mode: 'string' }).notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.taxonomyKey, table.symbol, table.effectiveFrom] }),
  instrumentEffectiveIdx: index('idx_sim_instrument_effective').on(
    table.instrumentKey, table.effectiveFrom, table.effectiveTo,
  ),
  level1EffectiveIdx: index('idx_sim_level1_effective').on(
    table.taxonomyKey, table.level1Code, table.effectiveFrom,
  ),
  level3EffectiveIdx: index('idx_sim_level3_effective').on(
    table.taxonomyKey, table.level3Code, table.effectiveFrom,
  ),
}));

export const swIndustryDailyBars = mysqlTable('sw_industry_daily_bars', {
  taxonomyKey: varchar('taxonomy_key', { length: 32 }).notNull(),
  indexCode: varchar('index_code', { length: 12 }).notNull(),
  industryCode: varchar('industry_code', { length: 12 }).notNull(),
  industryName: varchar('industry_name', { length: 128 }).notNull(),
  tradeDate: date('trade_date', { mode: 'string' }).notNull(),
  open: double('open').notNull(),
  high: double('high').notNull(),
  low: double('low').notNull(),
  close: double('close').notNull(),
  change: double('change'),
  changePercent: double('change_percent'),
  volumeRaw: double('volume_raw'),
  amountRaw: double('amount_raw'),
  sourceKey: varchar('source_key', { length: 64 }).notNull(),
  sourceVersion: varchar('source_version', { length: 64 }).notNull(),
  fetchedAt: datetime('fetched_at', { mode: 'string' }).notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.taxonomyKey, table.indexCode, table.tradeDate] }),
  tradeDateIdx: index('idx_sib_trade_date').on(table.tradeDate),
  industryDateIdx: index('idx_sib_industry_date').on(
    table.taxonomyKey, table.industryCode, table.tradeDate,
  ),
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

export const strategyExperiments = mysqlTable('strategy_experiments', {
  id: varchar('id', { length: 36 }).primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  sourceText: text('source_text').notNull(),
  createdAt: varchar('created_at', { length: 24 }).notNull(),
  updatedAt: varchar('updated_at', { length: 24 }).notNull(),
}, (table) => ({
  updatedAtIdx: index('idx_se_updated_at').on(table.updatedAt),
}));

export const strategyExperimentVersions = mysqlTable('strategy_experiment_versions', {
  id: varchar('id', { length: 36 }).primaryKey(),
  experimentId: varchar('experiment_id', { length: 36 }).notNull(),
  version: int('version').notNull(),
  status: varchar('status', { length: 24 }).notNull(),
  spec: json('spec').notNull(),
  specHash: varchar('spec_hash', { length: 64 }).notNull(),
  confirmation: json('confirmation').notNull(),
  capabilityVersion: varchar('capability_version', { length: 64 }).notNull(),
  compilerVersion: varchar('compiler_version', { length: 64 }).notNull(),
  createdAt: varchar('created_at', { length: 24 }).notNull(),
}, (table) => ({
  experimentVersionUnique: uniqueIndex('idx_sev_experiment_version').on(table.experimentId, table.version),
  specHashUnique: uniqueIndex('idx_sev_spec_hash').on(table.specHash),
  statusCreatedIdx: index('idx_sev_status_created').on(table.status, table.createdAt),
}));

export const strategyExperimentRuns = mysqlTable('strategy_experiment_runs', {
  id: varchar('id', { length: 36 }).primaryKey(),
  experimentVersionId: varchar('experiment_version_id', { length: 36 }).notNull(),
  status: varchar('status', { length: 24 }).notNull(),
  idempotencyKey: varchar('idempotency_key', { length: 128 }).notNull(),
  inputHash: varchar('input_hash', { length: 64 }).notNull(),
  executionPlan: json('execution_plan').notNull(),
  backtestResultId: varchar('backtest_result_id', { length: 36 }),
  resultHash: varchar('result_hash', { length: 64 }),
  validationStatus: varchar('validation_status', { length: 16 }),
  validationPolicyVersion: varchar('validation_policy_version', { length: 64 }),
  errorCode: varchar('error_code', { length: 64 }),
  errorMessage: varchar('error_message', { length: 1000 }),
  createdAt: varchar('created_at', { length: 24 }).notNull(),
  startedAt: varchar('started_at', { length: 24 }),
  completedAt: varchar('completed_at', { length: 24 }),
}, (table) => ({
  idempotencyUnique: uniqueIndex('idx_ser_idempotency').on(table.idempotencyKey),
  versionCreatedIdx: index('idx_ser_version_created').on(table.experimentVersionId, table.createdAt),
  statusCreatedIdx: index('idx_ser_status_created').on(table.status, table.createdAt),
}));

export const strategyExperimentEvents = mysqlTable('strategy_experiment_events', {
  id: bigint('id', { mode: 'number' }).autoincrement().primaryKey(),
  runId: varchar('run_id', { length: 36 }).notNull(),
  eventType: varchar('event_type', { length: 64 }).notNull(),
  payload: json('payload').notNull(),
  createdAt: varchar('created_at', { length: 24 }).notNull(),
}, (table) => ({
  runCreatedIdx: index('idx_see_run_created').on(table.runId, table.createdAt),
}));

export const strategyExperimentValidations = mysqlTable('strategy_experiment_validations', {
  id: varchar('id', { length: 36 }).primaryKey(),
  runId: varchar('run_id', { length: 36 }).notNull(),
  validationType: varchar('validation_type', { length: 64 }).notNull(),
  status: varchar('status', { length: 24 }).notNull(),
  details: json('details').notNull(),
  createdAt: varchar('created_at', { length: 24 }).notNull(),
}, (table) => ({
  runTypeUnique: uniqueIndex('idx_seval_run_type').on(table.runId, table.validationType),
}));

export const strategyExperimentValidationPolicies = mysqlTable('strategy_experiment_validation_policies', {
  id: varchar('id', { length: 36 }).primaryKey(),
  version: varchar('version', { length: 64 }).notNull(),
  status: varchar('status', { length: 16 }).notNull(),
  config: json('config').notNull(),
  configHash: varchar('config_hash', { length: 64 }).notNull(),
  createdAt: varchar('created_at', { length: 24 }).notNull(),
}, (table) => ({
  versionUnique: uniqueIndex('idx_sevp_version').on(table.version),
  statusCreatedIdx: index('idx_sevp_status_created').on(table.status, table.createdAt),
}));

export const strategyExperimentValidationPlans = mysqlTable('strategy_experiment_validation_plans', {
  id: varchar('id', { length: 36 }).primaryKey(),
  experimentVersionId: varchar('experiment_version_id', { length: 36 }).notNull(),
  policyId: varchar('policy_id', { length: 36 }).notNull(),
  samplePlan: json('sample_plan').notNull(),
  perturbationPlan: json('perturbation_plan').notNull(),
  planHash: varchar('plan_hash', { length: 64 }).notNull(),
  lockedTestStatus: varchar('locked_test_status', { length: 16 }).notNull().default('sealed'),
  lockedTestOpenedAt: varchar('locked_test_opened_at', { length: 24 }),
  lockedTestOpenToken: varchar('locked_test_open_token', { length: 64 }),
  createdAt: varchar('created_at', { length: 24 }).notNull(),
  updatedAt: varchar('updated_at', { length: 24 }).notNull(),
}, (table) => ({
  versionUnique: uniqueIndex('idx_sevplan_version').on(table.experimentVersionId),
  hashUnique: uniqueIndex('idx_sevplan_hash').on(table.planHash),
  openTokenUnique: uniqueIndex('idx_sevplan_open_token').on(table.lockedTestOpenToken),
}));

export const strategyExperimentGateEvaluations = mysqlTable('strategy_experiment_gate_evaluations', {
  id: varchar('id', { length: 36 }).primaryKey(),
  runId: varchar('run_id', { length: 36 }).notNull(),
  policyId: varchar('policy_id', { length: 36 }).notNull(),
  status: varchar('status', { length: 16 }).notNull(),
  checks: json('checks').notNull(),
  metricsSnapshot: json('metrics_snapshot').notNull(),
  calculatorVersion: varchar('calculator_version', { length: 64 }).notNull(),
  evaluationHash: varchar('evaluation_hash', { length: 64 }).notNull(),
  createdAt: varchar('created_at', { length: 24 }).notNull(),
}, (table) => ({
  runPolicyUnique: uniqueIndex('idx_sege_run_policy').on(table.runId, table.policyId),
  hashUnique: uniqueIndex('idx_sege_hash').on(table.evaluationHash),
}));

export const strategyExperimentReports = mysqlTable('strategy_experiment_reports', {
  id: varchar('id', { length: 36 }).primaryKey(),
  runId: varchar('run_id', { length: 36 }).notNull(),
  templateVersion: varchar('template_version', { length: 64 }).notNull(),
  structuredReport: json('structured_report').notNull(),
  markdown: text('markdown').notNull(),
  reportHash: varchar('report_hash', { length: 64 }).notNull(),
  createdAt: varchar('created_at', { length: 24 }).notNull(),
}, (table) => ({
  runTemplateUnique: uniqueIndex('idx_serpt_run_template').on(table.runId, table.templateVersion),
  hashUnique: uniqueIndex('idx_serpt_hash').on(table.reportHash),
}));

export const strategyExperimentArtifactJobs = mysqlTable('strategy_experiment_artifact_jobs', {
  id: varchar('id', { length: 36 }).primaryKey(),
  reportId: varchar('report_id', { length: 36 }).notNull(),
  format: varchar('format', { length: 16 }).notNull(),
  status: varchar('status', { length: 16 }).notNull(),
  cacheKey: varchar('cache_key', { length: 128 }).notNull(),
  artifactUri: varchar('artifact_uri', { length: 1024 }),
  errorMessage: varchar('error_message', { length: 1000 }),
  attempts: int('attempts').notNull().default(0),
  expiresAt: varchar('expires_at', { length: 24 }).notNull(),
  createdAt: varchar('created_at', { length: 24 }).notNull(),
  updatedAt: varchar('updated_at', { length: 24 }).notNull(),
}, (table) => ({
  cacheUnique: uniqueIndex('idx_seaj_cache').on(table.cacheKey),
  statusCreatedIdx: index('idx_seaj_status_created').on(table.status, table.createdAt),
  expiresIdx: index('idx_seaj_expires').on(table.expiresAt),
}));

// ─── M4 multi-asset research plans and runs ─────────────────────
export const multiAssetPlanVersions = mysqlTable('multi_asset_plan_versions', {
  id: varchar('id', { length: 36 }).primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  status: varchar('status', { length: 16 }).notNull().default('frozen'),
  snapshotId: varchar('snapshot_id', { length: 128 }).notNull(),
  planHash: varchar('plan_hash', { length: 64 }).notNull(),
  plan: json('plan').notNull(),
  snapshotConfig: json('snapshot_config').notNull(),
  createdAt: varchar('created_at', { length: 24 }).notNull(),
  updatedAt: varchar('updated_at', { length: 24 }).notNull(),
}, (table) => ({
  hashUnique: uniqueIndex('idx_mapv_hash').on(table.planHash),
  snapshotCreatedIdx: index('idx_mapv_snapshot_created').on(table.snapshotId, table.createdAt),
  statusCreatedIdx: index('idx_mapv_status_created').on(table.status, table.createdAt),
}));

export const multiAssetRuns = mysqlTable('multi_asset_runs', {
  id: varchar('id', { length: 36 }).primaryKey(),
  planVersionId: varchar('plan_version_id', { length: 36 }).notNull(),
  status: varchar('status', { length: 16 }).notNull().default('queued'),
  idempotencyKey: varchar('idempotency_key', { length: 128 }).notNull(),
  inputHash: varchar('input_hash', { length: 64 }).notNull(),
  initialCash: double('initial_cash').notNull(),
  progress: json('progress').notNull(),
  workerToken: varchar('worker_token', { length: 64 }),
  leaseExpiresAt: varchar('lease_expires_at', { length: 24 }),
  attemptCount: int('attempt_count').notNull().default(0),
  rebalancePlan: json('rebalance_plan'),
  executionResult: json('execution_result'),
  resultHash: varchar('result_hash', { length: 64 }),
  errorCode: varchar('error_code', { length: 64 }),
  errorMessage: varchar('error_message', { length: 1000 }),
  createdAt: varchar('created_at', { length: 24 }).notNull(),
  startedAt: varchar('started_at', { length: 24 }),
  completedAt: varchar('completed_at', { length: 24 }),
  updatedAt: varchar('updated_at', { length: 24 }).notNull(),
}, (table) => ({
  idempotencyUnique: uniqueIndex('idx_mar_idempotency').on(table.idempotencyKey),
  planCreatedIdx: index('idx_mar_plan_created').on(table.planVersionId, table.createdAt),
  statusCreatedIdx: index('idx_mar_status_created').on(table.status, table.createdAt),
  statusLeaseIdx: index('idx_mar_status_lease').on(table.status, table.leaseExpiresAt),
  resultHashIdx: index('idx_mar_result_hash').on(table.resultHash),
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
  // §3 派生列：从 request_snapshot->>'$.runKey' 自动抽取，STORED 生成列，无需应用层维护
  runKey: varchar('run_key', { length: 191 }).generatedAlwaysAs(
    sql`JSON_UNQUOTE(JSON_EXTRACT(request_snapshot, '$.runKey'))`,
    { mode: 'stored' },
  ),
  totalItems: int('total_items').notNull().default(0),
  completedItems: int('completed_items').notNull().default(0),
  failedItems: int('failed_items').notNull().default(0),
  startedAt: varchar('started_at', { length: 24 }),
  finishedAt: varchar('finished_at', { length: 24 }),
  createdAt: varchar('created_at', { length: 24 }).notNull(),
}, (table) => ({
  statusCreatedIdx: index('idx_sj_status_created').on(table.status, table.createdAt),
  typeIdx: index('idx_sj_type').on(table.jobType),
  runKeyIdx: index('idx_sj_run_key').on(table.status, table.runKey, table.createdAt),
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

export const factorMiningTasks = mysqlTable('factor_mining_tasks', {
  id: varchar('id', { length: 36 }).primaryKey(),
  status: varchar('status', { length: 16 }).notNull().default('pending'),
  snapshotId: varchar('snapshot_id', { length: 128 }).notNull(),
  config: json('config').notNull(),
  lineage: json('lineage').notNull(),
  totalGenerations: int('total_generations').notNull().default(0),
  completedGenerations: int('completed_generations').notNull().default(0),
  artifactUri: varchar('artifact_uri', { length: 1024 }),
  errorMessage: varchar('error_message', { length: 1000 }),
  createdAt: varchar('created_at', { length: 24 }).notNull(),
  startedAt: varchar('started_at', { length: 24 }),
  finishedAt: varchar('finished_at', { length: 24 }),
  workerPid: int('worker_pid'),
  archivedAt: varchar('archived_at', { length: 24 }),
  deletedAt: varchar('deleted_at', { length: 24 }),
}, (table) => ({
  statusIdx: index('idx_fmt_status_created').on(table.status, table.createdAt),
  snapshotIdx: index('idx_fmt_snapshot').on(table.snapshotId),
}));

export const factorCandidates = mysqlTable('factor_candidates', {
  id: varchar('id', { length: 36 }).primaryKey(),
  taskId: varchar('task_id', { length: 36 }).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  formula: varchar('formula', { length: 2000 }).notNull(),
  expression: json('expression').notNull(),
  direction: varchar('direction', { length: 24 }).notNull(),
  dependencies: json('dependencies').notNull(),
  warmupDays: int('warmup_days').notNull().default(0),
  status: varchar('status', { length: 16 }).notNull().default('draft'),
  validationMetrics: json('validation_metrics').notNull(),
  lockedTestMetrics: json('locked_test_metrics'),
  sourceLineage: json('source_lineage').notNull(),
  factorRunId: varchar('factor_run_id', { length: 36 }),
  publishedFactorVersionId: varchar('published_factor_version_id', { length: 96 }),
  rejectionReason: varchar('rejection_reason', { length: 1000 }),
  approvedBy: varchar('approved_by', { length: 128 }),
  approvedAt: varchar('approved_at', { length: 24 }),
  createdAt: varchar('created_at', { length: 24 }).notNull(),
  updatedAt: varchar('updated_at', { length: 24 }).notNull(),
}, (table) => ({
  taskStatusIdx: index('idx_fc_task_status').on(table.taskId, table.status),
  updatedAtIdx: index('idx_fc_updated_at').on(table.updatedAt),
}));

export const factorSearchFeedback = mysqlTable('factor_search_feedback', {
  signature: varchar('signature', { length: 64 }).primaryKey(),
  familySignature: varchar('family_signature', { length: 64 }).notNull(),
  direction: varchar('direction', { length: 24 }).notNull(),
  seenCount: int('seen_count', { unsigned: true }).notNull().default(1),
  failureCount: int('failure_count', { unsigned: true }).notNull().default(0),
  successCount: int('success_count', { unsigned: true }).notNull().default(0),
  lastCandidateId: varchar('last_candidate_id', { length: 36 }),
  lastReason: varchar('last_reason', { length: 1000 }),
  firstSeenAt: varchar('first_seen_at', { length: 24 }).notNull(),
  updatedAt: varchar('updated_at', { length: 24 }).notNull(),
}, (table) => ({
  familyDirectionIdx: index('idx_fsf_family_direction').on(table.familySignature, table.direction),
  outcomeIdx: index('idx_fsf_outcome').on(table.failureCount, table.successCount),
}));

export const factorCandidateAutomationSettings = mysqlTable('factor_candidate_automation_settings', {
  id: varchar('id', { length: 32 }).primaryKey(),
  enabled: int('enabled', { unsigned: true }).notNull().default(0),
  updatedAt: varchar('updated_at', { length: 24 }).notNull(),
});

export const factorMiningSchedules = mysqlTable('factor_mining_schedules', {
  id: varchar('id', { length: 36 }).primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  enabled: int('enabled').notNull().default(1),
  config: json('config').notNull(),
  totalGenerations: int('total_generations').notNull(),
  lastSnapshotId: varchar('last_snapshot_id', { length: 128 }),
  lastTestEndDate: varchar('last_test_end_date', { length: 10 }),
  lastTaskId: varchar('last_task_id', { length: 36 }),
  createdAt: varchar('created_at', { length: 24 }).notNull(),
  updatedAt: varchar('updated_at', { length: 24 }).notNull(),
}, (table) => ({
  enabledIdx: index('idx_fms_enabled_updated').on(table.enabled, table.updatedAt),
}));

// ─── Paper trading ───────────────────────────────────────────────
export const factorStrategyVersions = mysqlTable('factor_strategy_versions', {
  id: varchar('id', { length: 36 }).primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  parentVersionId: varchar('parent_version_id', { length: 36 }),
  status: varchar('status', { length: 16 }).notNull().default('draft'),
  factorVersions: json('factor_versions').notNull(),
  compositeWeights: json('composite_weights').notNull(),
  universeConfig: json('universe_config').notNull(),
  preprocessingConfig: json('preprocessing_config').notNull(),
  optimizerConfig: json('optimizer_config').notNull(),
  costConfig: json('cost_config').notNull(),
  snapshotId: varchar('snapshot_id', { length: 128 }).notNull(),
  codeChecksum: varchar('code_checksum', { length: 64 }).notNull(),
  randomSeeds: json('random_seeds').notNull(),
  paperAccountId: varchar('paper_account_id', { length: 36 }),
  createdAt: varchar('created_at', { length: 24 }).notNull(),
  updatedAt: varchar('updated_at', { length: 24 }).notNull(),
}, (table) => ({
  statusUpdatedIdx: index('idx_fsv_status_updated').on(table.status, table.updatedAt),
}));

export const factorStrategyEvaluations = mysqlTable('factor_strategy_evaluations', {
  id: varchar('id', { length: 36 }).primaryKey(),
  strategyVersionId: varchar('strategy_version_id', { length: 36 }).notNull(),
  evaluationType: varchar('evaluation_type', { length: 24 }).notNull(),
  metrics: json('metrics').notNull(),
  gateResult: json('gate_result').notNull(),
  artifactUri: varchar('artifact_uri', { length: 1024 }),
  createdAt: varchar('created_at', { length: 24 }).notNull(),
}, (table) => ({
  versionCreatedIdx: index('idx_fse_version_created').on(table.strategyVersionId, table.createdAt),
}));

export const factorStrategyPaperObservations = mysqlTable('factor_strategy_paper_observations', {
  id: varchar('id', { length: 36 }).primaryKey(),
  strategyVersionId: varchar('strategy_version_id', { length: 36 }).notNull(),
  rebalanceCycle: int('rebalance_cycle').notNull(),
  observationDate: varchar('observation_date', { length: 10 }).notNull(),
  metrics: json('metrics').notNull(),
  violations: json('violations').notNull(),
  createdAt: varchar('created_at', { length: 24 }).notNull(),
}, (table) => ({
  versionCycleUnique: uniqueIndex('idx_fspo_version_cycle')
    .on(table.strategyVersionId, table.rebalanceCycle),
}));

export const factorStrategyPromotionAudits = mysqlTable('factor_strategy_promotion_audits', {
  id: varchar('id', { length: 36 }).primaryKey(),
  strategyVersionId: varchar('strategy_version_id', { length: 36 }).notNull(),
  priorChampionId: varchar('prior_champion_id', { length: 36 }),
  decision: varchar('decision', { length: 16 }).notNull(),
  approvedBy: varchar('approved_by', { length: 128 }).notNull(),
  reason: varchar('reason', { length: 1000 }),
  gateResult: json('gate_result').notNull(),
  createdAt: varchar('created_at', { length: 24 }).notNull(),
}, (table) => ({
  versionCreatedIdx: index('idx_fspa_version_created').on(table.strategyVersionId, table.createdAt),
}));

export const paperAccounts = mysqlTable('paper_accounts', {
  id: varchar('id', { length: 36 }).primaryKey(),
  name: varchar('name', { length: 128 }).notNull(),
  currency: varchar('currency', { length: 3 }).notNull().default('CNY'),
  initialCash: decimal('initial_cash', { precision: 20, scale: 4 }).notNull(),
  cashBalance: decimal('cash_balance', { precision: 20, scale: 4 }).notNull(),
  frozenCash: decimal('frozen_cash', { precision: 20, scale: 4 }).notNull().default('0'),
  commissionRate: decimal('commission_rate', { precision: 12, scale: 8 }).notNull().default('0.00030000'),
  minimumCommission: decimal('minimum_commission', { precision: 20, scale: 4 }).notNull().default('5.0000'),
  sellTaxRate: decimal('sell_tax_rate', { precision: 12, scale: 8 }).notNull().default('0.00050000'),
  slippageBps: decimal('slippage_bps', { precision: 12, scale: 4 }).notNull().default('1.0000'),
  status: varchar('status', { length: 16 }).notNull().default('active'),
  createdAt: datetime('created_at', { mode: 'string', fsp: 3 }).notNull(),
  updatedAt: datetime('updated_at', { mode: 'string', fsp: 3 }).notNull(),
}, (table) => ({
  statusUpdatedIdx: index('idx_pa_status_updated').on(table.status, table.updatedAt),
}));

export const paperOrders = mysqlTable('paper_orders', {
  id: varchar('id', { length: 36 }).primaryKey(),
  accountId: varchar('account_id', { length: 36 }).notNull(),
  instrumentKey: int('instrument_key', { unsigned: true }).notNull(),
  clientOrderId: varchar('client_order_id', { length: 64 }).notNull(),
  securityCode: varchar('security_code', { length: 20 }).notNull(),
  securityName: varchar('security_name', { length: 255 }).notNull(),
  market: varchar('market', { length: 16 }).notNull(),
  side: varchar('side', { length: 8 }).notNull(),
  orderType: varchar('order_type', { length: 16 }).notNull(),
  timeInForce: varchar('time_in_force', { length: 8 }).notNull().default('day'),
  quantity: decimal('quantity', { precision: 20, scale: 6 }).notNull(),
  limitPrice: decimal('limit_price', { precision: 20, scale: 4 }),
  status: varchar('status', { length: 24 }).notNull(),
  filledQuantity: decimal('filled_quantity', { precision: 20, scale: 6 }).notNull().default('0'),
  averageFillPrice: decimal('average_fill_price', { precision: 20, scale: 4 }),
  frozenCash: decimal('frozen_cash', { precision: 20, scale: 4 }).notNull().default('0'),
  frozenQuantity: decimal('frozen_quantity', { precision: 20, scale: 6 }).notNull().default('0'),
  rejectCode: varchar('reject_code', { length: 64 }),
  rejectReason: varchar('reject_reason', { length: 500 }),
  ruleVersion: varchar('rule_version', { length: 64 }).notNull(),
  submittedAt: datetime('submitted_at', { mode: 'string', fsp: 3 }).notNull(),
  updatedAt: datetime('updated_at', { mode: 'string', fsp: 3 }).notNull(),
}, (table) => ({
  accountClientUnique: uniqueIndex('idx_po_account_client').on(table.accountId, table.clientOrderId),
  accountStatusIdx: index('idx_po_account_status').on(table.accountId, table.status, table.submittedAt),
  instrumentStatusIdx: index('idx_po_instrument_status').on(table.instrumentKey, table.status),
}));

export const paperPositions = mysqlTable('paper_positions', {
  accountId: varchar('account_id', { length: 36 }).notNull(),
  instrumentKey: int('instrument_key', { unsigned: true }).notNull(),
  securityCode: varchar('security_code', { length: 20 }).notNull(),
  securityName: varchar('security_name', { length: 255 }).notNull(),
  market: varchar('market', { length: 16 }).notNull(),
  totalQuantity: decimal('total_quantity', { precision: 20, scale: 6 }).notNull().default('0'),
  availableQuantity: decimal('available_quantity', { precision: 20, scale: 6 }).notNull().default('0'),
  frozenQuantity: decimal('frozen_quantity', { precision: 20, scale: 6 }).notNull().default('0'),
  averageCost: decimal('average_cost', { precision: 20, scale: 4 }).notNull().default('0'),
  lastPrice: decimal('last_price', { precision: 20, scale: 4 }),
  marketValue: decimal('market_value', { precision: 20, scale: 4 }).notNull().default('0'),
  realizedPnl: decimal('realized_pnl', { precision: 20, scale: 4 }).notNull().default('0'),
  updatedAt: datetime('updated_at', { mode: 'string', fsp: 3 }).notNull(),
}, (table) => ({
  accountInstrumentPk: primaryKey({ columns: [table.accountId, table.instrumentKey] }),
  instrumentIdx: index('idx_pp_instrument').on(table.instrumentKey),
}));

export const paperTrades = mysqlTable('paper_trades', {
  id: varchar('id', { length: 36 }).primaryKey(),
  orderId: varchar('order_id', { length: 36 }).notNull(),
  accountId: varchar('account_id', { length: 36 }).notNull(),
  instrumentKey: int('instrument_key', { unsigned: true }).notNull(),
  executionRunId: varchar('execution_run_id', { length: 36 }).notNull(),
  fillSequence: int('fill_sequence', { unsigned: true }).notNull(),
  side: varchar('side', { length: 8 }).notNull(),
  quantity: decimal('quantity', { precision: 20, scale: 6 }).notNull(),
  rawPrice: decimal('raw_price', { precision: 20, scale: 4 }).notNull(),
  fillPrice: decimal('fill_price', { precision: 20, scale: 4 }).notNull(),
  amount: decimal('amount', { precision: 20, scale: 4 }).notNull(),
  commission: decimal('commission', { precision: 20, scale: 4 }).notNull(),
  tax: decimal('tax', { precision: 20, scale: 4 }).notNull(),
  slippageCost: decimal('slippage_cost', { precision: 20, scale: 4 }).notNull(),
  quoteTime: datetime('quote_time', { mode: 'string', fsp: 3 }).notNull(),
  quoteSource: varchar('quote_source', { length: 64 }).notNull(),
  ruleVersion: varchar('rule_version', { length: 64 }).notNull(),
  createdAt: datetime('created_at', { mode: 'string', fsp: 3 }).notNull(),
}, (table) => ({
  orderRunSequenceUnique: uniqueIndex('idx_pt_order_run_seq').on(
    table.orderId,
    table.executionRunId,
    table.fillSequence,
  ),
  accountCreatedIdx: index('idx_pt_account_created').on(table.accountId, table.createdAt),
}));
