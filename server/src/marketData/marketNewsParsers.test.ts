import { describe, expect, it } from 'vitest';
import fixture from './fixtures/market-news.json' with { type: 'json' };
import { parseClsTelegraph, parseEastmoneyGlobalNews, parseEastmoneyStockNews, sortNewsByTimeAndPriority } from './marketNewsParsers.js';
import { buildClsSignature } from './http/clsClient.js';

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

  it('maps CLS telegraph items and keeps the local signature vector stable', () => {
    const items = parseClsTelegraph(fixture.cls);
    expect(items[0]).toMatchObject({
      newsId: '2430170', sourceKey: 'cls', sourceTier: 'professional', securityCode: '601728',
    });
    expect(items[0]?.tags).toContain('人工智能');
    expect(buildClsSignature({
      appName: 'CailianpressWeb', os: 'web', sv: '7.7.5', last_time: '', refresh_type: '1', rn: '50',
    })).toBe('b849fe86598f3ceca205eda7b33a49a1');
  });
});
