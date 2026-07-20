import { and, desc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import { getDb, schema } from '../../db/index.js';
import type { MarketNewsItem, NewsSourceTier } from '../marketNewsTypes.js';
import { buildCanonicalNewsHash } from '../marketNewsDedup.js';

const { marketNews } = schema;

export async function upsertMarketNews(items: MarketNewsItem[]): Promise<void> {
  if (!items.length) return;
  const fetchedAt = mysqlUtcNow();
  await getDb().insert(marketNews).values(items.map((item) => ({
    newsId: item.newsId,
    sourceKey: item.sourceKey,
    sourceName: item.sourceName,
    sourceTier: item.sourceTier,
    contentType: item.contentType,
    sourceUrl: item.sourceUrl ?? null,
    title: item.title,
    summary: item.summary ?? null,
    content: item.content ?? null,
    publishedAt: toMysqlUtc(item.publishedAt),
    securityCode: item.securityCode ?? null,
    securityName: item.securityName ?? null,
    industry: item.industry ?? null,
    tags: item.tags ?? null,
    raw: item.raw ?? null,
    canonicalHash: item.canonicalHash,
    fetchedAt,
  }))).onDuplicateKeyUpdate({ set: {
    sourceName: sql`VALUES(${marketNews.sourceName})`,
    sourceTier: sql`VALUES(${marketNews.sourceTier})`,
    contentType: sql`VALUES(${marketNews.contentType})`,
    sourceUrl: sql`VALUES(${marketNews.sourceUrl})`,
    title: sql`VALUES(${marketNews.title})`,
    summary: sql`VALUES(${marketNews.summary})`,
    content: sql`VALUES(${marketNews.content})`,
    canonicalHash: sql`VALUES(${marketNews.canonicalHash})`,
    fetchedAt: sql`VALUES(${marketNews.fetchedAt})`,
  } });
}

export async function listMarketNews(options: {
  limit: number;
  tier?: NewsSourceTier;
  securityCode?: string;
  before?: string;
  beforeId?: number;
}): Promise<MarketNewsItem[]> {
  const filters = [];
  if (options.tier) filters.push(eq(marketNews.sourceTier, options.tier));
  if (options.securityCode) filters.push(eq(marketNews.securityCode, options.securityCode));
  if (options.before) {
    const before = toMysqlUtc(options.before);
    filters.push(options.beforeId == null
      ? lt(marketNews.publishedAt, before)
      : or(
        lt(marketNews.publishedAt, before),
        and(eq(marketNews.publishedAt, before), lt(marketNews.id, options.beforeId)),
      )!);
  }
  const rows = await getDb().select().from(marketNews)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(marketNews.publishedAt), desc(marketNews.id))
    .limit(options.limit);
  return rows.map(toDomain);
}

export async function deleteMarketNewsBefore(cutoffIso: string, limit = 5_000): Promise<number> {
  const result = await getDb().execute(sql`
    DELETE FROM ${marketNews}
    WHERE ${marketNews.publishedAt} < ${toMysqlUtc(cutoffIso)}
    LIMIT ${Math.max(1, Math.min(limit, 20_000))}
  `);
  const packet = result[0] as { affectedRows?: number };
  return Number(packet.affectedRows ?? 0);
}

export async function latestNewsFetchedAtBySource(): Promise<Array<{ sourceKey: string; fetchedAt: string }>> {
  const rows = await getDb().select({
    sourceKey: marketNews.sourceKey,
    fetchedAt: sql<string>`MAX(${marketNews.fetchedAt})`,
  }).from(marketNews).groupBy(marketNews.sourceKey);
  return rows.map((row) => ({ sourceKey: row.sourceKey, fetchedAt: fromMysqlUtc(row.fetchedAt) }));
}

function toDomain(row: typeof marketNews.$inferSelect): MarketNewsItem {
  return {
    id: row.id,
    newsId: row.newsId,
    sourceKey: row.sourceKey as MarketNewsItem['sourceKey'],
    sourceName: row.sourceName,
    sourceTier: row.sourceTier as MarketNewsItem['sourceTier'],
    contentType: row.contentType as MarketNewsItem['contentType'],
    sourceUrl: row.sourceUrl ?? undefined,
    title: row.title,
    summary: row.summary ?? undefined,
    content: row.content ?? undefined,
    publishedAt: fromMysqlUtc(row.publishedAt),
    securityCode: row.securityCode ?? undefined,
    securityName: row.securityName ?? undefined,
    industry: row.industry ?? undefined,
    tags: Array.isArray(row.tags) ? row.tags as string[] : undefined,
    canonicalHash: buildCanonicalNewsHash(row.title, fromMysqlUtc(row.publishedAt)),
    raw: row.raw ?? undefined,
  };
}

function mysqlUtcNow(): string {
  return toMysqlUtc(new Date().toISOString());
}

function toMysqlUtc(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid datetime: ${value}`);
  return parsed.toISOString().replace('T', ' ').replace('Z', '');
}

function fromMysqlUtc(value: string): string {
  return new Date(`${value.replace(' ', 'T')}Z`).toISOString();
}
