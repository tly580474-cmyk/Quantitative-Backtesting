import { describe, expect, it } from 'vitest';
import type { MarketNewsItem } from '../marketData/marketNewsTypes.js';
import { assessOpinionNews, rankOpinionNews } from './marketOpinionNewsRanker.js';

const NOW = Date.parse('2026-07-20T01:00:00.000Z');

function news(overrides: Partial<MarketNewsItem> = {}): MarketNewsItem {
  return {
    newsId: 'news-1',
    sourceKey: 'cls',
    sourceName: '财联社',
    sourceTier: 'professional',
    contentType: 'flash',
    title: '央行宣布下调政策利率10个基点',
    summary: '人民银行宣布自7月20日起实施，政策利率下调10个基点。',
    publishedAt: '2026-07-20T00:30:00.000Z',
    canonicalHash: 'hash-1',
    sourceUrl: 'https://example.com/news/1',
    ...overrides,
  };
}

describe('market opinion news ranker', () => {
  it('scores verified policy facts above generic market commentary', () => {
    const policy = assessOpinionNews(news(), NOW);
    const commentary = assessOpinionNews(news({
      newsId: 'commentary',
      title: '机构认为市场后续有望保持活跃',
      summary: '分析师预计市场或将震荡上行，建议关注相关机会。',
      sourceUrl: undefined,
    }), NOW);
    expect(policy.score).toBeGreaterThan(commentary.score);
    expect(policy.category).toBe('policy_macro');
    expect(commentary.reasons).toContain('纯观点无新增事实 -20');
  });

  it('hard-rejects promotional and fact-poor material', () => {
    expect(assessOpinionNews(news({ title: '机会来了！一文看懂今日潜力股' }), NOW).hardRejected).toBe(true);
    expect(assessOpinionNews(news({ title: '【电报解读】高潜力赛道打开长期成长空间，公司收入增长50%' }), NOW).hardRejected).toBe(true);
    expect(assessOpinionNews(news({ title: '市场消息', summary: '简讯' }), NOW).hardRejected).toBe(true);
  });

  it('caps total events, individual sources, and crowded themes', () => {
    const items = Array.from({ length: 40 }, (_, index) => news({
      newsId: `news-${index}`,
      canonicalHash: `hash-${index}`,
      title: `央行发布第${index}项货币政策决定 涉及资金${index + 1}亿元`,
      sourceKey: index % 3 === 0 ? 'cls' : index % 3 === 1 ? 'eastmoney_global' : 'xinwenlianbo',
      sourceName: index % 3 === 0 ? '财联社' : index % 3 === 1 ? '东方财富' : '新闻联播',
      sourceTier: index % 3 === 2 ? 'state_media' : 'professional',
    }));
    const ranked = rankOpinionNews(items, NOW);
    expect(ranked.length).toBeLessThanOrEqual(18);
    expect(ranked.filter((entry) => entry.assessment.category === 'policy_macro')).toHaveLength(4);
    const counts = Object.values(ranked.reduce<Record<string, number>>((result, entry) => ({
      ...result,
      [entry.item.sourceKey]: (result[entry.item.sourceKey] ?? 0) + 1,
    }), {}));
    expect(Math.max(...counts)).toBeLessThanOrEqual(8);
  });

  it('keeps Friday-close information for a Monday morning report but excludes older material', () => {
    const friday = news({
      newsId: 'friday-close',
      canonicalHash: 'friday-close',
      publishedAt: '2026-07-17T08:00:00.000Z',
      title: '央行周五宣布下调政策利率10个基点',
    });
    const thursday = news({
      newsId: 'thursday-old',
      canonicalHash: 'thursday-old',
      publishedAt: '2026-07-16T08:00:00.000Z',
      title: '央行周四宣布下调政策利率10个基点',
    });
    const selected = rankOpinionNews([friday, thursday], NOW).map((entry) => entry.item.newsId);
    expect(selected).toContain('friday-close');
    expect(selected).not.toContain('thursday-old');
  });
});
