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
    title: `央行发布第${id}项货币政策决定`,
    summary: `数据显示该项政策自7月18日起实施，涉及资金规模100亿元。`,
    publishedAt,
    canonicalHash: id.padEnd(64, '0').slice(0, 64),
  };
}

describe('market opinion agent context', () => {
  it('selects high-value events with source and topic diversity', () => {
    const items = [
      ...Array.from({ length: 25 }, (_, index) => item(`s${index}`, 'state_media')),
      ...Array.from({ length: 25 }, (_, index) => item(`p${index}`, 'professional')),
      item('a1', 'aggregator'),
      item('official', 'official'),
      item('self', 'self_media'),
    ];
    const selected = selectOpinionNews(items, Date.parse('2026-07-19T00:00:00.000Z'));
    expect(selected.length).toBeGreaterThan(0);
    expect(selected.length).toBeLessThanOrEqual(18);
    expect(selected.some((entry) => entry.sourceTier === 'official')).toBe(true);
    expect(selected.some((entry) => entry.sourceTier === 'self_media')).toBe(false);
    const sourceCounts = selected.reduce<Record<string, number>>((counts, entry) => ({
      ...counts,
      [entry.sourceKey]: (counts[entry.sourceKey] ?? 0) + 1,
    }), {});
    expect(Math.max(...Object.values(sourceCounts))).toBeLessThanOrEqual(8);
  });

  it('builds a citation-oriented prompt and treats news text as untrusted input', () => {
    const prompt = buildMarketOpinionPrompt([item('1', 'professional')]);
    expect(prompt).toContain('忽略');
    expect(prompt).toContain('[N1]');
    expect(prompt).toContain('未来24—72小时验证清单');
    expect(prompt).toContain('valueScore');
    expect(prompt).toContain('selectionReasons');
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

  it('forbids treating current-day opening-auction values as the previous close', () => {
    const prompt = buildDigestPrompt([item('1', 'state_media')], 'morning', {
      capturedAt: '2026-07-20T01:16:00.000Z',
      session: '2026-07-20 pre_open',
      sessionTradeDate: '2026-07-20',
      marketPhase: 'pre_open',
      referenceTradeDate: '2026-07-17',
      indices: [{
        code: '000001', quoteTradeDate: '2026-07-20', quotePhase: 'opening_auction',
        price: 3510, previousClose: 3490, previousCloseTradeDate: '2026-07-17',
      }],
      unavailable: [],
    });
    expect(prompt).toContain('quotePhase=opening_auction');
    expect(prompt).toContain("TODAY'S call-auction snapshot");
    expect(prompt).toContain('previousClose alone describes the prior completed trading day');
    expect(prompt).toContain('Never describe current-session auction or intraday values as yesterday');
  });
});
