import type { MarketNewsItem, MarketNewsSnapshot, NewsSourceTier } from '../marketData/marketNewsTypes.js';
import type { MarketOpinionMarketContext } from './marketOpinionAgent.js';

export interface MarketOpinionFreshnessPolicy {
  newsMaxAgeMinutes: number;
  marketMaxAgeMinutes: number;
  minNewsSources: number;
}

export interface FreshMarketOpinionInputs {
  news: MarketNewsItem[];
  newsSnapshot: MarketNewsSnapshot;
  context: MarketOpinionMarketContext;
}

export const DEFAULT_MARKET_OPINION_FRESHNESS_POLICY: MarketOpinionFreshnessPolicy = {
  newsMaxAgeMinutes: 10,
  marketMaxAgeMinutes: 10,
  minNewsSources: 2,
};

const OPINION_TIERS = new Set<NewsSourceTier>(['official', 'state_media', 'professional', 'aggregator']);

/**
 * Fail closed before an opinion is generated. A recent collector heartbeat is not
 * sufficient: the exact news and market snapshots supplied to the model must pass.
 */
export function assertFreshMarketOpinionInputs(
  inputs: FreshMarketOpinionInputs,
  now = new Date(),
  policy: MarketOpinionFreshnessPolicy = DEFAULT_MARKET_OPINION_FRESHNESS_POLICY,
): void {
  const failures: string[] = [];
  const newsMaxAgeMs = positiveMinutes(policy.newsMaxAgeMinutes) * 60_000;
  const marketMaxAgeMs = positiveMinutes(policy.marketMaxAgeMinutes) * 60_000;

  if (inputs.newsSnapshot.stale) failures.push('新闻刷新返回了陈旧缓存');
  checkTimestamp('新闻采集快照', inputs.newsSnapshot.updatedAt, newsMaxAgeMs, now, failures);

  const news = inputs.news.filter((item) => OPINION_TIERS.has(item.sourceTier));
  const sources = new Set(inputs.newsSnapshot.sources);
  if (!news.length) failures.push('本次采集没有可供观点智能体使用的新闻');
  if (sources.size < Math.max(1, Math.floor(policy.minNewsSources))) {
    failures.push(`本次新闻采集仅有 ${sources.size} 个有效来源，至少需要 ${Math.max(1, Math.floor(policy.minNewsSources))} 个`);
  }

  const unavailable = Array.isArray(inputs.context.unavailable) ? inputs.context.unavailable : [];
  if (unavailable.length) failures.push(`行情上下文缺失：${unavailable.join('、')}`);
  checkTimestamp('行情快照', inputs.context.capturedAt, marketMaxAgeMs, now, failures);
  const preOpen = inputs.context.marketPhase === 'pre_open' || inputs.context.session.endsWith(' pre_open');
  const referenceTradeDate = inputs.context.referenceTradeDate ?? inputs.context.dataTradeDate;

  const indices = records(inputs.context.indices);
  if (!indices.length) failures.push('指数行情为空');
  for (const item of indices) {
    checkTimestamp(`指数行情 ${String(item.code ?? item.name ?? '')}`.trim(), item.updatedAt, marketMaxAgeMs, now, failures);
  }

  const sentiment = record(inputs.context.sentiment);
  if (!sentiment) failures.push('市场情绪为空');
  else checkTimestamp('市场情绪', sentiment.updatedAt, marketMaxAgeMs, now, failures);

  const capitalFlow = record(inputs.context.capitalFlow);
  if (!capitalFlow) failures.push('全市场主力资金为空');
  else {
    const previousClose = preOpen && matchesTradeDate(capitalFlow.tradeDate, referenceTradeDate);
    if (capitalFlow.stale === true && !previousClose) failures.push(`全市场主力资金使用了陈旧缓存${reasonSuffix(capitalFlow.fallbackReason)}`);
    if (!previousClose) checkTimestamp('全市场主力资金', capitalFlow.updatedAt, marketMaxAgeMs, now, failures);
  }

  const hotSectors = record(inputs.context.hotSectors);
  if (!hotSectors) failures.push('热点板块为空');
  else {
    const previousClose = preOpen && matchesTradeDate(hotSectors.dataTradeDate, referenceTradeDate);
    if (hotSectors.stale === true && !previousClose) failures.push(`热点板块使用了陈旧缓存${reasonSuffix(hotSectors.fallbackReason)}`);
    if (!previousClose) checkTimestamp('热点板块', hotSectors.snapshotTime, marketMaxAgeMs, now, failures);
  }

  if (failures.length) throw new Error(`观点智能体数据新鲜度门禁未通过：${failures.join('；')}`);
}

export function formatMarketOpinionFreshnessEvidence(inputs: FreshMarketOpinionInputs): string {
  const names = new Map<string, string>(inputs.news.map((item) => [item.sourceKey, item.sourceName]));
  const sources = inputs.newsSnapshot.sources.map((source) => `${names.get(source) ?? source}(${source})`);
  return [
    '## 数据新鲜度',
    '',
    `- 新闻采集快照：${inputs.newsSnapshot.updatedAt}`,
    `- 新闻来源：${sources.join('、')}`,
    `- 行情快照：${inputs.context.capturedAt}`,
    `- 当前会话交易日：${inputs.context.sessionTradeDate ?? inputs.context.session.slice(0, 10)}`,
    `- 上一已完成交易日：${inputs.context.referenceTradeDate ?? inputs.context.dataTradeDate ?? '未知'}`,
  ].join('\n');
}

function checkTimestamp(
  label: string,
  value: unknown,
  maxAgeMs: number,
  now: Date,
  failures: string[],
): void {
  const timestamp = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(timestamp)) {
    failures.push(`${label}缺少有效时间戳`);
    return;
  }
  const ageMs = now.getTime() - timestamp;
  if (ageMs < -2 * 60_000) failures.push(`${label}时间戳超前 ${Math.ceil(-ageMs / 60_000)} 分钟`);
  else if (ageMs > maxAgeMs) failures.push(`${label}已陈旧 ${Math.floor(ageMs / 60_000)} 分钟`);
}

function positiveMinutes(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function records(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.map(record).filter((item): item is Record<string, unknown> => item !== null) : [];
}

function reasonSuffix(value: unknown): string {
  return typeof value === 'string' && value.trim() ? `（${value.trim()}）` : '';
}

function matchesTradeDate(value: unknown, expected: string | null | undefined): boolean {
  return typeof value === 'string' && Boolean(expected) && value === expected;
}
