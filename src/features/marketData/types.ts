export interface Instrument {
  id: string;
  market: string;
  symbol: string;
  name: string;
  type: string;
  listDate?: string;
  delistDate?: string;
  status: string;
  startDate?: string;
  endDate?: string;
  qualityStatus?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DataFreshness {
  totalInstruments: number;
  syncedInstruments: number;
  latestTradeDate: string | null;
  pendingTradeDates: number;
  failedSyncCount: number;
  openIssueCount: number;
}

export interface SyncJob {
  id: string;
  jobType: string;
  status: string;
  providerId: string;
  requestSnapshot: Record<string, unknown>;
  totalItems: number;
  completedItems: number;
  failedItems: number;
  startedAt?: string;
  finishedAt?: string;
  createdAt: string;
  items?: SyncJobItem[];
}

export interface SyncJobItem {
  id: string;
  jobId: string;
  instrumentId: string;
  status: string;
  attempts: number;
  errorCode?: string;
  errorMessage?: string;
}

export interface DataQualityIssue {
  id: string;
  instrumentId: string;
  tradeDate: string;
  ruleCode: string;
  severity: string;
  status: string;
  details?: Record<string, unknown>;
  detectedAt: string;
  resolvedAt?: string;
}

export interface StockSearchItem {
  code: string;
  name: string;
  market: 'SH' | 'SZ' | 'BJ';
  type: 'stock' | 'index' | 'etf';
}

export interface StockQuote extends StockSearchItem {
  price: number | null;
  changeAmount: number | null;
  changePct: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  previousClose: number | null;
  limitUp: number | null;
  limitDown: number | null;
  turnoverPct: number | null;
  amplitudePct: number | null;
  volumeRatio: number | null;
  amountWan: number | null;
  peTtm: number | null;
  peStatic: number | null;
  pb: number | null;
  marketCapYi: number | null;
  floatMarketCapYi: number | null;
  listDate: string | null;
  industry: string | null;
  updatedAt: string;
  source: string[];
}

export interface KlinePoint {
  date: string;
  open: number;
  close: number;
  high: number;
  low: number;
  volume: number;
}

export interface ResearchReport {
  title: string;
  publishDate: string;
  organization: string;
  rating: string;
  industry: string;
  pdfUrl: string | null;
  infoCode: string;
}

export interface AgentStatus {
  configured: boolean;
  currentModel: string;
  availableModels: string[];
  workflow: string[];
}
