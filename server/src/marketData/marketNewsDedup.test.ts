import { describe, expect, it } from 'vitest';
import { buildCanonicalNewsHash, clusterMarketNews, sameNewsEvent } from './marketNewsDedup.js';
import type { MarketNewsItem } from './marketNewsTypes.js';

function news(overrides: Partial<MarketNewsItem>): MarketNewsItem {
  const title = overrides.title ?? '中国电信董事长：将适度超前建设算力基础设施';
  const publishedAt = overrides.publishedAt ?? '2026-07-18T06:02:00.000Z';
  return {
    newsId: overrides.newsId ?? '1', sourceKey: overrides.sourceKey ?? 'eastmoney_global',
    sourceName: overrides.sourceName ?? '东方财富全球资讯', sourceTier: overrides.sourceTier ?? 'professional',
    contentType: overrides.contentType ?? 'flash', title, publishedAt,
    canonicalHash: buildCanonicalNewsHash(title, publishedAt), ...overrides,
  };
}

describe('market news event clustering', () => {
  it('merges the same headline across sources despite minute and security extraction differences', () => {
    const items = clusterMarketNews([
      news({ newsId: 'eastmoney-1', publishedAt: '2026-07-18T06:02:00.000Z' }),
      news({ newsId: 'cls-1', sourceKey: 'cls', sourceName: '财联社电报', publishedAt: '2026-07-18T06:04:00.000Z', securityCode: '601728', summary: '更完整的事件摘要' }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ sourceName: '财联社电报', sourceCount: 2, securityCode: '601728' });
    expect(items[0]?.relatedSources?.map((source) => source.sourceKey)).toEqual(['eastmoney_global', 'cls']);
  });

  it('clusters small editorial headline differences inside the event window', () => {
    const left = news({ title: '柬国航签约采购20架国产C909飞机', publishedAt: '2026-07-18T06:17:00.000Z' });
    const right = news({ title: '柬埔寨国家航空签约采购20架中国C909飞机', sourceKey: 'cls', publishedAt: '2026-07-18T06:19:00.000Z' });
    expect(sameNewsEvent(left, right)).toBe(true);
  });

  it('does not merge headlines with conflicting numeric facts', () => {
    const left = news({ title: '公司拟回购1亿元股份' });
    const right = news({ title: '公司拟回购2亿元股份', sourceKey: 'cls', publishedAt: '2026-07-18T06:03:00.000Z' });
    expect(sameNewsEvent(left, right)).toBe(false);
    const sharedYearLeft = news({ title: '公司2026年拟采购20架飞机' });
    const sharedYearRight = news({ title: '公司2026年拟采购30架飞机', sourceKey: 'cls', publishedAt: '2026-07-18T06:03:00.000Z' });
    expect(sameNewsEvent(sharedYearLeft, sharedYearRight)).toBe(false);
  });

  it('counts distinct media sources rather than repeated records from one feed', () => {
    const items = clusterMarketNews([
      news({ newsId: 'eastmoney-1' }),
      news({ newsId: 'eastmoney-2', publishedAt: '2026-07-18T06:03:00.000Z' }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]?.sourceCount).toBe(1);
  });
});
