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

export type MarketCode = 'SH' | 'SZ' | 'BJ' | 'HK' | 'US' | 'JP' | 'KR';

export interface StockSearchItem {
  code: string;
  name: string;
  market: MarketCode;
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
  amount?: number;
  previousClose?: number | null;
  change?: number | null;
  changePct?: number | null;
  isTradable?: boolean;
  /** Daily turnover rate in percentage points; 0.41 means 0.41%. */
  turnoverRatePct?: number;
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

export interface HotSectorItem {
  code: string;
  name: string;
  type: 'industry' | 'concept';
  rank: number;
  heatScore: number;
  changePct: number | null;
  amountYi: number | null;
  mainNetInYi: number | null;
  mainNetRatio: number | null;
  advancers: number | null;
  decliners: number | null;
  breadthPct: number | null;
  leadingStock: string | null;
  leadingStockChangePct: number | null;
  signals: string[];
  scoreDetail: {
    momentum: number;
    capital: number;
    breadth: number;
    activity: number;
    persistence: number;
  };
}

export interface HotSectorSnapshot {
  items: HotSectorItem[];
  updatedAt: string;
  total: number;
  source: string;
}

export interface DragonTigerSeat {
  tradeId: string;
  tradeDate: string;
  code: string;
  side: 'buy' | 'sell';
  rank: number;
  operateDeptCode: string | null;
  seatName: string;
  buyAmt: number | null;
  sellAmt: number | null;
  netAmt: number | null;
  isInstitutional: boolean;
}

export interface DragonTigerMarketItem {
  tradeId: string;
  tradeDate: string;
  rank: number;
  code: string;
  name: string;
  exchange: 'SH' | 'SZ' | 'BJ';
  explanation: string;
  changeType: string | null;
  netBuyAmt: number | null;
  buyAmt: number | null;
  sellAmt: number | null;
  billboardDealAmt: number | null;
  closePrice: number | null;
  changePct: number | null;
  turnoverRate: number | null;
  sourceKey: string;
}

export interface DragonTigerMarketSnapshot {
  tradeDate: string;
  items: DragonTigerMarketItem[];
  total: number;
  updatedAt: string;
  source: string;
  stale?: boolean;
}

export interface DragonTigerStockRecord extends DragonTigerMarketItem {
  buySeats: DragonTigerSeat[];
  sellSeats: DragonTigerSeat[];
}

export interface DragonTigerStockDetail {
  code: string;
  name: string;
  records: DragonTigerStockRecord[];
  updatedAt: string;
}

export type NewsSourceTier = 'official' | 'state_media' | 'professional' | 'aggregator' | 'self_media';

export interface MarketNewsItem {
  id?: number;
  newsId: string;
  sourceKey: string;
  sourceName: string;
  sourceTier: NewsSourceTier;
  contentType: 'flash' | 'article' | 'announcement' | 'irm';
  sourceUrl?: string;
  title: string;
  summary?: string;
  content?: string;
  publishedAt: string;
  securityCode?: string;
  securityName?: string;
  industry?: string;
  tags?: string[];
  canonicalHash: string;
  sourceCount?: number;
  relatedSources?: Array<{
    newsId: string;
    sourceKey: string;
    sourceName: string;
    sourceTier: NewsSourceTier;
    sourceUrl?: string;
    publishedAt: string;
  }>;
}

export interface MarketNewsSnapshot {
  items: MarketNewsItem[];
  total: number;
  updatedAt: string;
  sources: string[];
  nextCursor?: { before: string; beforeId?: number };
  stale?: boolean;
}

export interface MarketOpinionSource {
  ref: string;
  title: string;
  sourceName: string;
  sourceTier: NewsSourceTier;
  sourceUrl?: string;
  publishedAt: string;
}

export interface MarketOpinionReport {
  content: string;
  model: string;
  generatedAt: string;
  periodStart: string;
  periodEnd: string;
  newsCount: number;
  sourceCount: number;
  tierCounts: Partial<Record<NewsSourceTier, number>>;
  sources: MarketOpinionSource[];
  reasoningSummary: string[];
  cached: boolean;
}

export interface MarketOpinionStatus {
  configured: boolean;
  currentModel: string;
  availableModels: string[];
  inputTiers: NewsSourceTier[];
  workflow: string[];
  latest: MarketOpinionReport | null;
}

export interface SectorConstituent {
  rank: number;
  code: string;
  name: string;
  price: number | null;
  changePct: number | null;
  turnoverPct: number | null;
  amountYi: number | null;
  volumeRatio: number | null;
  high: number | null;
  low: number | null;
  open: number | null;
  previousClose: number | null;
  mainNetInYi: number | null;
  mainNetRatio: number | null;
}

export interface SectorConstituentSnapshot {
  sectorCode: string;
  sectorName: string;
  items: SectorConstituent[];
  total: number;
  updatedAt: string;
  source: string;
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

export type MarketBreadthBucketKey =
  | 'upLimit' | 'up5' | 'up1' | 'up0' | 'flat'
  | 'down0' | 'down1' | 'down5' | 'downLimit';

export interface MarketBreadthStock {
  code: string;
  name: string;
  market: 'SH' | 'SZ' | 'BJ';
  price: number | null;
  changePct: number;
  amountYi: number | null;
  turnoverPct: number | null;
  amplitudePct: number | null;
  volumeRatio: number | null;
}

export interface MarketBreadthBucket {
  key: MarketBreadthBucketKey;
  label: string;
  count: number;
  tone: 'up' | 'flat' | 'down';
  items: MarketBreadthStock[];
}

export interface MarketSentimentOverview {
  modelVersion: 2;
  updatedAt: string;
  total: number;
  advancers: number;
  decliners: number;
  flat: number;
  upLimit: number;
  downLimit: number;
  mainNetInYi: number | null;
  mainNetSampleCount: number;
  totalAmountYi: number;
  volumeBaselineYi: number | null;
  northboundNetYi: number | null;
  hs300AmplitudePct: number | null;
  hs300Amplitude20dPct: number | null;
  breakRate: number | null;
  ma5AbovePct: number | null;
  distribution: MarketBreadthBucket[];
  mainNetInTrend: Array<{ time: string; value: number }>;
  factors: MarketSentimentFactor[];
  msi: number;
  breadthIndexDivergence: number;
  structure: 'broad-rally' | 'broad-decline' | 'small-cap-led' | 'large-cap-led' | 'balanced';
  structureLabel: string;
  structureDescription: string;
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
  key: 'signal' | 'capital' | 'fundamental' | 'announcement' | 'news';
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
