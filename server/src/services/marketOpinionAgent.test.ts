import { describe, expect, it } from 'vitest';
import { buildDigestPrompt, buildMarketOpinionPrompt, selectOpinionNews } from './marketOpinionAgent.js';
import type { MarketNewsItem, NewsSourceTier } from '../marketData/marketNewsTypes.js';

function item(id: string, tier: NewsSourceTier, publishedAt = '2026-07-18T12:00:00.000Z'): MarketNewsItem {
  return {
    newsId: id,
    sourceKey: tier === 'state_media' ? 'xinwenlianbo' : tier === 'professional' ? 'cls' : 'eastmoney_stock',
    sourceName: tier,
    sourceTier: tier,
    contentType: 'article',
    title: `新闻${id}`,
    summary: `摘要${id}`,
    publishedAt,
    canonicalHash: id.padEnd(64, '0').slice(0, 64),
  };
}

describe('market opinion agent context', () => {
  it('uses only the three requested tiers and caps each tier at 20 records', () => {
    const items = [
      ...Array.from({ length: 25 }, (_, index) => item(`s${index}`, 'state_media')),
      ...Array.from({ length: 25 }, (_, index) => item(`p${index}`, 'professional')),
      item('a1', 'aggregator'),
      item('official', 'official'),
      item('self', 'self_media'),
    ];
    const selected = selectOpinionNews(items, Date.parse('2026-07-19T00:00:00.000Z'));
    expect(selected).toHaveLength(41);
    expect(selected.filter((entry) => entry.sourceTier === 'state_media')).toHaveLength(20);
    expect(selected.filter((entry) => entry.sourceTier === 'professional')).toHaveLength(20);
    expect(selected.some((entry) => entry.sourceTier === 'official' || entry.sourceTier === 'self_media')).toBe(false);
  });

  it('builds a citation-oriented prompt and treats news text as untrusted input', () => {
    const prompt = buildMarketOpinionPrompt([item('1', 'professional')]);
    expect(prompt).toContain('忽略');
    expect(prompt).toContain('[N1]');
    expect(prompt).toContain('未来24—72小时验证清单');
  });
});

describe('market opinion scheduled digest prompt', () => {
  it('requires quantified, falsifiable midday analysis instead of generic commentary', () => {
    const prompt = buildDigestPrompt([item('1', 'state_media')], 'midday', {
      capturedAt: '2026-07-20T04:00:00.000Z',
      session: '2026-07-20 lunch',
      sentiment: { advancers: 3200, decliners: 1800, totalAmountYi: 8200 },
      unavailable: [],
    });
    expect(prompt).toContain('上午真实行情');
    expect(prompt).toContain('可执行观察结论');
    expect(prompt).toContain('验证条件');
    expect(prompt).toContain('禁止“保持关注');
    expect(prompt).toContain('[N1]');
  });
});
