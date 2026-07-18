import { describe, expect, it } from 'vitest';
import fixture from './fixtures/market-news.json' with { type: 'json' };
import { parseEastmoneyGlobalNews, parseEastmoneyStockNews, sortNewsByTimeAndPriority } from './marketNewsParsers.js';

describe('market news parsers', () => {
  it('maps global fast news and normalizes Beijing time to UTC', () => {
    const items = parseEastmoneyGlobalNews(fixture.global);
    expect(items[0]).toMatchObject({ sourceKey: 'eastmoney_global', contentType: 'flash' });
    expect(items[0].publishedAt).toBe('2026-07-18T01:30:00.000Z');
    expect(items[0].canonicalHash).toHaveLength(64);
  });

  it('parses stock JSONP list directly and strips markup', () => {
    const items = parseEastmoneyStockNews(fixture.stockJsonp, '688017');
    expect(items[0]).toMatchObject({ securityCode: '688017', title: '688017 个股新闻' });
  });

  it('sorts the realtime feed by time before source tier', () => {
    const olderOfficial = { ...parseEastmoneyGlobalNews(fixture.global)[0], sourceTier: 'official' as const, publishedAt: '2026-07-18T00:00:00.000Z' };
    const newerProfessional = { ...parseEastmoneyGlobalNews(fixture.global)[0], publishedAt: '2026-07-18T02:00:00.000Z' };
    expect(sortNewsByTimeAndPriority([olderOfficial, newerProfessional])[0].publishedAt).toBe(newerProfessional.publishedAt);
  });
});
