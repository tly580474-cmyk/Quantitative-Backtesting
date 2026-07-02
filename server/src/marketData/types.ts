// ─── Domain Types for Phase 5 ──────────────────────────────────────

export type Market = 'SH' | 'SZ' | 'BJ';
export type InstrumentType = 'stock' | 'index' | 'etf';
export type InstrumentStatus = 'active' | 'delisted' | 'suspended';
export type SyncJobType = 'instruments' | 'calendar' | 'history' | 'incremental';
export type SyncJobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
export type SyncItemStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
export type QualitySeverity = 'pass' | 'warning' | 'blocked';
export type QualityIssueStatus = 'open' | 'confirmed' | 'ignored' | 'resolved';

// ─── Instrument ────────────────────────────────────────────────────
export interface Instrument {
  id: string;
  market: Market;
  symbol: string;
  name: string;
  type: InstrumentType;
  listDate?: string;
  delistDate?: string;
  status: InstrumentStatus;
  createdAt: string;
  updatedAt: string;
}

// ─── Provider Symbol Mapping ───────────────────────────────────────
export interface ProviderSymbolMapping {
  id: string;
  providerId: string;
  instrumentId: string;
  providerSymbol: string;
}

// ─── Trading Calendar ──────────────────────────────────────────────
export interface TradingCalendarEntry {
  id: string;
  market: Market;
  tradeDate: string;
  isOpen: boolean;
  sessionMetadata?: Record<string, unknown>;
}

// ─── Daily Candle (normalized, stored) ─────────────────────────────
export interface DailyCandle {
  id: string;
  instrumentId: string;
  tradeDate: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  turnover?: number;
  turnoverRatePct?: number;
  sourceId: string;
  sourceVersion: string;
  fetchedAt: string;
}

// ─── Adjustment Factor ─────────────────────────────────────────────
export interface AdjustmentFactorRecord {
  id: string;
  instrumentId: string;
  tradeDate: string;
  factor: number;
  sourceId: string;
  fetchedAt: string;
}

// ─── Market Data Version ───────────────────────────────────────────
export interface MarketDataVersion {
  id: string;
  instrumentId: string;
  startDate: string;
  endDate: string;
  checksum: string;
  adjustmentVersion: string;
  qualityStatus: QualitySeverity;
  recordCount: number;
  createdAt: string;
}

// ─── Sync Job ──────────────────────────────────────────────────────
export interface SyncJob {
  id: string;
  jobType: SyncJobType;
  status: SyncJobStatus;
  providerId: string;
  requestSnapshot: SyncRequestSnapshot;
  totalItems: number;
  completedItems: number;
  failedItems: number;
  startedAt?: string;
  finishedAt?: string;
  createdAt: string;
}

export interface SyncRequestSnapshot {
  market?: string;
  symbols?: string[];
  startDate?: string;
  endDate?: string;
}

export interface SyncJobItem {
  id: string;
  jobId: string;
  instrumentId: string;
  status: SyncItemStatus;
  attempts: number;
  errorCode?: string;
  errorMessage?: string;
}

// ─── Data Quality ──────────────────────────────────────────────────
export interface DataQualityIssue {
  id: string;
  instrumentId: string;
  tradeDate: string;
  ruleCode: string;
  severity: QualitySeverity;
  status: QualityIssueStatus;
  details?: Record<string, unknown>;
  detectedAt: string;
  resolvedAt?: string;
}

// ─── Data Freshness ────────────────────────────────────────────────
export interface DataFreshness {
  totalInstruments: number;
  syncedInstruments: number;
  latestTradeDate: string | null;
  pendingTradeDates: number;
  failedSyncCount: number;
  openIssueCount: number;
}

// ─── Adjusted Candle (derived, not stored) ─────────────────────────
export interface AdjustedCandle {
  tradeDate: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  turnover?: number;
  turnoverRatePct?: number;
  adjustmentMode: 'none' | 'qfq' | 'hfq';
}
