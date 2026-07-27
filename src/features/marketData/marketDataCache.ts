import type { AgentStatus, KlinePoint, MarketKlinePeriod, MarketSentimentOverview, ResearchReport, SevenLayerSection, StockQuote, StockSearchItem, TradingStyleId } from './types';
import type { SelectionScoreContext } from './selectionScore';

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
  scoreKlines: Record<string, KlinePoint[]>;
  scoreContexts: Record<string, { data: SelectionScoreContext; cachedAt: number }>;
  reports: Record<string, ResearchReport[]>;
  sevenLayer: Record<string, Partial<Record<SevenLayerSection['key'], SevenLayerSection>>>;
  indexQuotes?: StockQuote[];
  marketSentiment?: MarketSentimentOverview;
  agentStatus?: AgentStatus;
  agentQuestion: string;
  agentModel?: string;
  agentStyles: TradingStyleId[];
  agentResults: Record<string, AgentResultCache>;
}

export const marketDataCache: MarketDataPageCache = {
  period: 'day',
  quotes: {},
  klines: {},
  scoreKlines: {},
  scoreContexts: {},
  reports: {},
  sevenLayer: {},
  indexQuotes: undefined,
  marketSentiment: undefined,
  agentQuestion: '请结合全市场环境、消息面和个股证据，给出可验证的条件式交易计划。',
  agentStyles: ['value'],
  agentResults: {},
};

export function klineCacheKey(
  code: string,
  period: MarketDataPageCache['period'],
  fullHistory = false,
) {
  return `${code}:${period}${fullHistory ? ':full' : ''}`;
}
