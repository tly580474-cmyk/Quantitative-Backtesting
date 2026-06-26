import type { AgentStatus, KlinePoint, MarketKlinePeriod, MarketSentimentOverview, ResearchReport, SevenLayerSection, StockQuote, StockSearchItem } from './types';

interface AgentResultCache {
  content: string;
  reasoningSummary: string[];
}

interface MarketDataPageCache {
  watchlist?: StockSearchItem[];
  selectedCode?: string;
  period: MarketKlinePeriod;
  quotes: Record<string, StockQuote>;
  klines: Record<string, KlinePoint[]>;
  reports: Record<string, ResearchReport[]>;
  sevenLayer: Record<string, Partial<Record<SevenLayerSection['key'], SevenLayerSection>>>;
  indexQuotes?: StockQuote[];
  marketSentiment?: MarketSentimentOverview;
  agentStatus?: AgentStatus;
  agentQuestion: string;
  agentModel?: string;
  agentResults: Record<string, AgentResultCache>;
}

export const marketDataCache: MarketDataPageCache = {
  period: 'day',
  quotes: {},
  klines: {},
  reports: {},
  sevenLayer: {},
  indexQuotes: undefined,
  marketSentiment: undefined,
  agentQuestion: '请综合评估当前估值、趋势、机构观点和主要风险。',
  agentResults: {},
};

export function klineCacheKey(code: string, period: MarketDataPageCache['period']) {
  return `${code}:${period}`;
}
