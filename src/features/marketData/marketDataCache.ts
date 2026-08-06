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
  /** K 线缓存写入时间戳（毫秒），用于 TTL 判定 */
  klineCachedAt: Record<string, number>;
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

/** 指数预览 K 线缓存 TTL（10 分钟），避免长期显示陈旧走势 */
export const INDEX_KLINE_CACHE_TTL_MS = 10 * 60 * 1000;
/** 指数预览分时缓存 TTL（3 分钟），盘中分时变化快 */
export const INDEX_INTRADAY_CACHE_TTL_MS = 3 * 60 * 1000;

export const marketDataCache: MarketDataPageCache = {
  period: 'day',
  quotes: {},
  klines: {},
  klineCachedAt: {},
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

/**
 * 读取指数预览 K 线缓存。超过 TTL 视为缺失，调用方应重新拉取。
 * 返回 null 表示缓存不存在或已过期。
 */
export function readIndexKlineCache(cacheKey: string): KlinePoint[] | null {
  const cached = marketDataCache.klines[cacheKey];
  if (!cached) return null;
  const cachedAt = marketDataCache.klineCachedAt[cacheKey];
  if (!cachedAt) return null;
  if (Date.now() - cachedAt > INDEX_KLINE_CACHE_TTL_MS) return null;
  return cached;
}

/**
 * 写入指数预览 K 线缓存并记录写入时间。空数组不写入，避免短期故障被长期缓存。
 */
export function writeIndexKlineCache(cacheKey: string, items: KlinePoint[]): void {
  if (items.length === 0) return;
  marketDataCache.klines[cacheKey] = items;
  marketDataCache.klineCachedAt[cacheKey] = Date.now();
}

/**
 * 读取指数预览分时缓存。超过 TTL 视为缺失。
 * 返回 null 表示缓存不存在或已过期。
 */
export function readIndexIntradayCache(cacheKey: string): KlinePoint[] | null {
  const cached = marketDataCache.klines[cacheKey];
  if (!cached) return null;
  const cachedAt = marketDataCache.klineCachedAt[cacheKey];
  if (!cachedAt) return null;
  if (Date.now() - cachedAt > INDEX_INTRADAY_CACHE_TTL_MS) return null;
  return cached;
}

/**
 * 写入指数预览分时缓存并记录写入时间。空数组不写入。
 */
export function writeIndexIntradayCache(cacheKey: string, items: KlinePoint[]): void {
  if (items.length === 0) return;
  marketDataCache.klines[cacheKey] = items;
  marketDataCache.klineCachedAt[cacheKey] = Date.now();
}

export function klineCacheKey(
  code: string,
  period: MarketDataPageCache['period'],
  fullHistory = false,
) {
  return `${code}:${period}${fullHistory ? ':full' : ''}`;
}
