import { createHash } from 'node:crypto';
import { parseLooseJson } from './http/looseJson.js';
import { TIER_PRIORITY, type MarketNewsItem } from './marketNewsTypes.js';

export function parseEastmoneyGlobalNews(data: unknown): MarketNewsItem[] {
  const payload = data as { data?: { fastNewsList?: Array<Record<string, unknown>> } };
  return (payload.data?.fastNewsList ?? []).map((row) => buildItem({
    newsId: text(row.code ?? row.id ?? row.newsId) || hash(`${row.title}|${row.showTime}`),
    sourceKey: 'eastmoney_global',
    sourceName: '东方财富全球资讯',
    sourceTier: 'professional',
    contentType: 'flash',
    sourceUrl: optionalText(row.newsUrl ?? row.news_url ?? row.url),
    title: stripMarkup(text(row.title) || text(row.summary).slice(0, 80)),
    summary: optionalText(stripMarkup(text(row.summary ?? row.content)).slice(0, 500)),
    publishedAt: normalizeDateTime(row.showTime ?? row.publishTime ?? row.time),
    raw: row,
  }));
}

export function parseEastmoneyStockNews(jsonp: string, securityCode: string): MarketNewsItem[] {
  const payload = parseLooseJson(jsonp) as { result?: { cmsArticleWebOld?: Array<Record<string, unknown>> } };
  return (payload.result?.cmsArticleWebOld ?? []).map((row) => buildItem({
    newsId: text(row.code ?? row.id ?? row.artCode) || hash(`${securityCode}|${row.title}|${row.date}`),
    sourceKey: 'eastmoney_stock',
    sourceName: text(row.mediaName) || '东方财富个股新闻',
    sourceTier: 'aggregator',
    contentType: 'article',
    sourceUrl: optionalText(row.url),
    title: stripMarkup(text(row.title)),
    summary: optionalText(stripMarkup(text(row.content)).slice(0, 500)),
    publishedAt: normalizeDateTime(row.date ?? row.publishTime),
    securityCode,
    raw: row,
  }));
}

export function sortNewsByTimeAndPriority(items: MarketNewsItem[]): MarketNewsItem[] {
  return [...items].sort((a, b) => {
    const byTime = b.publishedAt.localeCompare(a.publishedAt);
    return byTime || TIER_PRIORITY[a.sourceTier] - TIER_PRIORITY[b.sourceTier];
  });
}

function buildItem(input: Omit<MarketNewsItem, 'canonicalHash'>): MarketNewsItem {
  const bucket = input.publishedAt.slice(0, 16);
  return { ...input, canonicalHash: hash(`${normalizeTitle(input.title)}|${bucket}|${input.securityCode ?? ''}`) };
}

function normalizeDateTime(value: unknown): string {
  const raw = text(value);
  if (!raw) return new Date(0).toISOString();
  if (/^\d{10,13}$/.test(raw)) {
    const numeric = Number(raw);
    return new Date(raw.length === 10 ? numeric * 1000 : numeric).toISOString();
  }
  const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T');
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(normalized);
  const parsed = new Date(hasZone ? normalized : `${normalized}+08:00`);
  return Number.isNaN(parsed.getTime()) ? new Date(0).toISOString() : parsed.toISOString();
}

function normalizeTitle(value: string): string {
  return value.toLowerCase().replace(/[\s，。！？、；：,.!?;:'"“”‘’（）()【】\[\]-]/g, '');
}

function stripMarkup(value: string): string {
  return value.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

function text(value: unknown): string {
  return value == null ? '' : String(value).trim();
}

function optionalText(value: unknown): string | undefined {
  const result = text(value);
  return result || undefined;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
