import { createHash } from 'node:crypto';
import { buildCanonicalNewsHash } from './marketNewsDedup.js';
import type { MarketNewsItem } from './marketNewsTypes.js';

const PLACEHOLDER_TITLE = /对不起.*(?:网络原因|无此页面|稍后尝试)/;

export function parseXinwenLianboHtml(html: string, programDate: string): MarketNewsItem[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(programDate)) throw new Error(`Invalid 新闻联播 date: ${programDate}`);
  const publishedAt = new Date(`${programDate}T19:00:00+08:00`).toISOString();
  const pageUrl = `https://cn.govopendata.com/xinwenlianbo/${programDate.replace(/-/g, '')}/`;
  const items: MarketNewsItem[] = [];
  const articlePattern = /<article\b([^>]*)class=["'][^"']*content-section[^"']*["']([^>]*)>([\s\S]*?)<\/article>/gi;
  for (const match of html.matchAll(articlePattern)) {
    const attributes = `${match[1] ?? ''} ${match[2] ?? ''}`;
    const sectionHtml = match[3] ?? '';
    const sectionId = /\bid=["']([^"']+)["']/i.exec(attributes)?.[1]
      ?? `section-${createHash('sha1').update(sectionHtml).digest('hex').slice(0, 12)}`;
    const title = cleanText(/<h2\b[^>]*class=["'][^"']*content-heading[^"']*["'][^>]*>([\s\S]*?)<\/h2>/i.exec(sectionHtml)?.[1] ?? '');
    const bodyHtml = /<div\b[^>]*class=["'][^"']*content-body[^"']*["'][^>]*>([\s\S]*?)<\/div>/i.exec(sectionHtml)?.[1] ?? '';
    const content = cleanText(bodyHtml);
    if (!title || !content || PLACEHOLDER_TITLE.test(title)) continue;
    const sourceUrl = `${pageUrl}#${sectionId}`;
    items.push({
      newsId: `${programDate}:${sectionId}`,
      sourceKey: 'xinwenlianbo',
      sourceName: '央视新闻联播文字稿（公开数据平台）',
      sourceTier: 'state_media',
      contentType: 'article',
      sourceUrl,
      title,
      summary: content.slice(0, 500),
      content: content.slice(0, 4_000),
      publishedAt,
      tags: ['新闻联播'],
      canonicalHash: buildCanonicalNewsHash(title, publishedAt),
      raw: { programDate, sectionId, mirror: 'cn.govopendata.com' },
    });
  }
  return items;
}

function cleanText(value: string): string {
  return decodeEntities(value.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' '))
    .replace(/[\t\r ]+/g, ' ').replace(/\n\s+/g, '\n').trim();
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity, token: string) => {
    if (token.startsWith('#x')) return String.fromCodePoint(Number.parseInt(token.slice(2), 16));
    if (token.startsWith('#')) return String.fromCodePoint(Number.parseInt(token.slice(1), 10));
    return named[token.toLowerCase()] ?? entity;
  });
}
