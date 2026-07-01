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

export interface WatchlistScoreSnapshot {
  code: string;
  score: number | null;
  tier: 'core' | 'watch' | 'weak' | 'blocked' | null;
  tierLabel: string;
  asOf: string | null;
  status: 'ready' | 'insufficient' | 'error';
  updatedAt: string;
}

export interface MarketScreenerCriteria {
  markets: Array<'SH' | 'SZ' | 'BJ'>;
  minChangePct: number;
  maxChangePct: number;
  minAmountYi: number;
  minTurnoverPct: number;
  minVolumeRatio: number;
  maxAmplitudePct: number;
  excludeRiskNames: boolean;
  trend: 'any' | 'bullish' | 'aboveMa20' | 'bearish';
  returnPeriod: 5 | 10 | 20;
  minPeriodReturn: number;
  maxPeriodReturn: number;
  streakDirection: 'any' | 'up' | 'down';
  minStreakDays: number;
  minRsi: number;
  maxRsi: number;
  kdjSignal: 'any' | 'golden' | 'death';
  macdSignal: 'any' | 'golden' | 'death';
  limit: number;
}

export interface HistoricalTechnicalIndicators {
  asOf: string;
  close: number;
  ma5: number;
  ma10: number;
  ma20: number;
  ma60: number;
  trend: 'bullish' | 'aboveMa20' | 'bearish' | 'mixed';
  return5d: number;
  return10d: number;
  return20d: number;
  streak: number;
  rsi14: number;
  kdjK: number;
  kdjD: number;
  kdjJ: number;
  kdjSignal: 'golden' | 'death' | 'none';
  macdDif: number;
  macdDea: number;
  macdHistogram: number;
  macdSignal: 'golden' | 'death' | 'none';
}

export interface MarketTechnicalCandidate extends StockSearchItem {
  price: number | null;
  changePct: number | null;
  amountYi: number | null;
  turnoverPct: number | null;
  amplitudePct: number | null;
  volumeRatio: number | null;
  technicalScore: number;
  matchedSignals: string[];
  indicators: HistoricalTechnicalIndicators | null;
}

export interface MarketScreenerSnapshot {
  items: MarketTechnicalCandidate[];
  totalScanned: number;
  totalEnriched: number;
  updatedAt: string;
}

export type MarketKlinePeriod = 'intraday' | 'day' | 'week' | 'year';

export interface ResearchReport {
  title: string;
  publishDate: string;
  organization: string;
  rating: string;
  industry: string;
  pdfUrl: string | null;
  infoCode: string;
}

export interface MarketSentimentFactor {
  key: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G';
  label: string;
  value: number;
  weight: number;
  source: 'live' | 'estimated' | 'neutral';
  formula: string;
  description: string;
}

export interface MarketSentimentOverview {
  updatedAt: string;
  total: number;
  advancers: number;
  decliners: number;
  flat: number;
  upLimit: number;
  downLimit: number;
  mainNetInYi: number;
  totalAmountYi: number;
  volumeBaselineYi: number | null;
  northboundNetYi: number | null;
  hs300AmplitudePct: number | null;
  hs300Amplitude20dPct: number | null;
  breakRate: number | null;
  ma5AbovePct: number | null;
  distribution: Array<{ key: string; label: string; count: number; tone: 'up' | 'flat' | 'down' }>;
  mainNetInTrend: Array<{ time: string; value: number }>;
  factors: MarketSentimentFactor[];
  msi: number;
  status: 'euphoria' | 'bullish' | 'neutral' | 'bearish' | 'panic';
  statusLabel: string;
  notes: string[];
}

export interface AgentStatus {
  configured: boolean;
  currentModel: string;
  availableModels: string[];
  workflow: string[];
}

export type SevenLayerStatus = 'ok' | 'partial' | 'degraded';

export interface SevenLayerRecord {
  source: string;
  title: string;
  date?: string;
  url?: string;
  summary?: string;
  metrics?: Record<string, unknown>;
  raw?: unknown;
}

export interface SevenLayerSection {
  key: 'signal' | 'capital' | 'fundamental' | 'announcement';
  title: string;
  status: SevenLayerStatus;
  summary: string;
  sources: string[];
  records: SevenLayerRecord[];
  errors: string[];
}

export interface SevenLayerSnapshot {
  code: string;
  market: 'SH' | 'SZ' | 'BJ';
  secid: string;
  name: string;
  updatedAt: string;
  sections: SevenLayerSection[];
}
