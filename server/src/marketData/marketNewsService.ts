import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchCninfoAnnouncements, type MainlandMarket } from './http/cninfoClient.js';
import { limitedFetchJson, limitedFetchText } from './http/eastmoneyClient.js';
import { fetchClsTelegraph } from './http/clsClient.js';
import { buildCanonicalNewsHash, clusterMarketNews } from './marketNewsDedup.js';
import { parseClsTelegraph, parseEastmoneyGlobalNews, parseEastmoneyStockNews, sortNewsByTimeAndPriority } from './marketNewsParsers.js';
import type { MarketNewsItem, MarketNewsSnapshot, NewsSourceTier } from './marketNewsTypes.js';
import { listMarketNews, upsertMarketNews } from './repositories/marketNewsRepository.js';

const GLOBAL_NEWS_URL = 'https://np-weblist.eastmoney.com/comm/web/getFastNewsList';
const STOCK_NEWS_URL = 'https://search-api-web.eastmoney.com/search/jsonp';
const CACHE_MS = 3 * 60_000;
const serverRoot = process.cwd().replace(/[\\/]server$/, '') === process.cwd() ? resolve(process.cwd(), 'server') : process.cwd();
const CACHE_FILE = localModulePath('../../.cache/market-news.json', '.cache/market-news.json');
let marketCache: { data: MarketNewsSnapshot; cachedAt: number } | null = null;
let marketInFlight: Promise<MarketNewsSnapshot> | null = null;
const stockCache = new Map<string, { data: MarketNewsSnapshot; cachedAt: number }>();

export async function getMarketNews(options: {
  force?: boolean;
  dbOnline?: boolean;
  limit?: number;
  tier?: NewsSourceTier;
  before?: string;
  beforeId?: number;
} = {}): Promise<MarketNewsSnapshot> {
  const limit = clampLimit(options.limit);
  const isFirstPage = !options.before && !options.tier;
  if (!options.force && isFirstPage && marketCache && Date.now() - marketCache.cachedAt < CACHE_MS) {
    return { ...marketCache.data, items: marketCache.data.items.slice(0, limit), total: Math.min(marketCache.data.total, limit) };
  }
  if (!options.force && options.dbOnline !== false) {
    const stored = await listMarketNews({ limit, tier: options.tier, before: options.before, beforeId: options.beforeId });
    if (stored.length) return buildSnapshot(clusterMarketNews(stored), stored);
    // A cursor identifies an older database page. Refreshing the live first page here
    // would return duplicates and make cursor pagination loop forever.
    if (options.before) return buildSnapshot([]);
  }
  if (marketInFlight && isFirstPage) return marketInFlight;
  const operation = refreshMarketNews(options.dbOnline !== false, limit).finally(() => { marketInFlight = null; });
  if (isFirstPage) marketInFlight = operation;
  try {
    const refreshed = await operation;
    const filtered = options.tier ? refreshed.items.filter((item) => item.sourceTier === options.tier) : refreshed.items;
    return buildSnapshot(filtered.slice(0, limit));
  } catch (error) {
    const fallback = await readCache();
    if (fallback) return { ...fallback, items: fallback.items.slice(0, limit), stale: true };
    throw error;
  }
}

export async function getStockNews(
  inputCode: string,
  options: { force?: boolean; dbOnline?: boolean; limit?: number } = {},
): Promise<MarketNewsSnapshot> {
  const code = normalizeCode(inputCode);
  const limit = clampLimit(options.limit);
  const cached = stockCache.get(code);
  if (!options.force && cached && Date.now() - cached.cachedAt < CACHE_MS) return cached.data;
  if (!options.force && options.dbOnline !== false) {
    const stored = await listMarketNews({ limit, securityCode: code });
    if (stored.length) return rememberStock(code, buildSnapshot(clusterMarketNews(stored), stored));
  }
  const callback = `jQuery_news_${Date.now()}`;
  const param = JSON.stringify({
    uid: '', keyword: code, type: ['cmsArticleWebOld'], client: 'web', clientType: 'web', clientVersion: 'curr',
    param: { cmsArticleWebOld: { searchScope: 'default', sort: 'default', pageIndex: 1, pageSize: limit, preTag: '', postTag: '' } },
  });
  const [stockText, announcements] = await Promise.all([
    limitedFetchText(STOCK_NEWS_URL, { params: { cb: callback, param }, referer: 'https://so.eastmoney.com/' }),
    fetchCninfoAnnouncements(code, inferMarket(code), Math.min(limit, 10)).catch(() => []),
  ]);
  const rawItems = sortNewsByTimeAndPriority([
    ...parseEastmoneyStockNews(stockText, code),
    ...announcements.map((item) => mapAnnouncement(item, code)),
  ]).slice(0, limit);
  if (options.dbOnline !== false) await upsertMarketNews(rawItems);
  return rememberStock(code, buildSnapshot(clusterMarketNews(rawItems), rawItems));
}

export async function refreshMarketNews(dbOnline = true, limit = 50): Promise<MarketNewsSnapshot> {
  const results = await Promise.allSettled([
    limitedFetchJson<unknown>(GLOBAL_NEWS_URL, {
      client: 'web', biz: 'web_724', fastColumn: '102', sortEnd: '',
      pageSize: String(Math.max(20, limit)), req_trace: randomUUID(),
    }, 'https://kuaixun.eastmoney.com/'),
    fetchClsTelegraph(limit),
  ]);
  const rawItems = sortNewsByTimeAndPriority([
    ...(results[0].status === 'fulfilled' ? parseEastmoneyGlobalNews(results[0].value) : []),
    ...(results[1].status === 'fulfilled' ? parseClsTelegraph(results[1].value) : []),
  ]);
  if (!rawItems.length) {
    const reasons = results.map((result) => result.status === 'rejected' ? String(result.reason) : '').filter(Boolean);
    throw new Error(`市场新闻主备源均不可用：${reasons.join('; ')}`);
  }
  if (dbOnline) await upsertMarketNews(rawItems);
  const result = buildSnapshot(clusterMarketNews(rawItems), rawItems);
  marketCache = { data: result, cachedAt: Date.now() };
  await writeCache(result);
  return result;
}

function mapAnnouncement(item: Awaited<ReturnType<typeof fetchCninfoAnnouncements>>[number], code: string): MarketNewsItem {
  const title = item.title;
  const publishedAt = normalizePublishedAt(item.publishedAt);
  return {
    newsId: item.id || hash(`${code}|${title}|${publishedAt}`),
    sourceKey: 'cninfo',
    sourceName: '巨潮资讯',
    sourceTier: 'official',
    contentType: 'announcement',
    sourceUrl: item.url,
    title,
    publishedAt,
    securityCode: code,
    securityName: item.name || undefined,
    canonicalHash: buildCanonicalNewsHash(title, publishedAt),
    raw: item.raw,
  };
}

function buildSnapshot(items: MarketNewsItem[], cursorItems: MarketNewsItem[] = items): MarketNewsSnapshot {
  const last = cursorItems.at(-1);
  return {
    items,
    total: items.length,
    updatedAt: new Date().toISOString(),
    sources: [...new Set(cursorItems.map((item) => item.sourceKey))],
    nextCursor: last ? { before: last.publishedAt, beforeId: last.id } : undefined,
  };
}

function rememberStock(code: string, data: MarketNewsSnapshot): MarketNewsSnapshot {
  stockCache.set(code, { data, cachedAt: Date.now() });
  return data;
}

async function writeCache(data: MarketNewsSnapshot): Promise<void> {
  await mkdir(dirname(CACHE_FILE), { recursive: true });
  await writeFile(CACHE_FILE, JSON.stringify(data), 'utf8');
}

async function readCache(): Promise<MarketNewsSnapshot | null> {
  try { return JSON.parse(await readFile(CACHE_FILE, 'utf8')) as MarketNewsSnapshot; } catch { return null; }
}

function normalizeCode(value: string): string {
  const match = value.match(/\d{6}/);
  if (!match) throw new Error('请输入有效的 6 位 A 股代码');
  return match[0];
}

function inferMarket(code: string): MainlandMarket {
  if (/^[689]/.test(code)) return 'SH';
  if (/^[48]/.test(code)) return 'BJ';
  return 'SZ';
}

function clampLimit(value?: number): number {
  return Math.max(1, Math.min(100, Number.isFinite(value) ? Number(value) : 20));
}

function normalizePublishedAt(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date(0).toISOString() : parsed.toISOString();
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function localModulePath(relativeUrl: string, fallbackFromServerRoot: string): string {
  try { return fileURLToPath(new URL(relativeUrl, import.meta.url)); } catch { return resolve(serverRoot, fallbackFromServerRoot); }
}
