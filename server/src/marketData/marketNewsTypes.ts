export type NewsSourceTier = 'official' | 'state_media' | 'professional' | 'aggregator' | 'self_media';
export type NewsContentType = 'flash' | 'article' | 'announcement' | 'irm';

export interface MarketNewsItem {
  id?: number;
  newsId: string;
  sourceKey: 'eastmoney_global' | 'eastmoney_stock' | 'cninfo' | 'sse' | 'szse';
  sourceName: string;
  sourceTier: NewsSourceTier;
  contentType: NewsContentType;
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
  raw?: unknown;
}

export interface MarketNewsSnapshot {
  items: MarketNewsItem[];
  total: number;
  updatedAt: string;
  sources: string[];
  nextCursor?: { before: string; beforeId?: number };
  stale?: boolean;
}

export const TIER_PRIORITY: Record<NewsSourceTier, number> = {
  official: 1,
  state_media: 2,
  professional: 3,
  aggregator: 4,
  self_media: 5,
};
