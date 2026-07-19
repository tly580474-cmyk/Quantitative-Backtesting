import { describe, expect, it } from 'vitest';
import { appendReferenceArticles } from './marketOpinionPushService.js';
import type { MarketOpinionReport } from './marketOpinionAgent.js';

function report(): MarketOpinionReport {
  return {
    content: '第一条判断[N3]，第二条判断[N1]，重复引用[N3]。',
    model: 'test',
    generatedAt: '2026-07-19T05:00:00.000Z',
    periodStart: '2026-07-19T01:00:00.000Z',
    periodEnd: '2026-07-19T04:00:00.000Z',
    newsCount: 3,
    sourceCount: 2,
    tierCounts: {},
    sources: [
      { ref: 'N3', title: '第三篇[报道]', sourceName: '专业财经', sourceTier: 'professional', sourceUrl: 'https://example.com/news/3', publishedAt: '2026-07-19T03:00:00.000Z' },
      { ref: 'N2', title: '未引用报道', sourceName: '聚合', sourceTier: 'aggregator', sourceUrl: 'https://example.com/news/2', publishedAt: '2026-07-19T02:00:00.000Z' },
      { ref: 'N1', title: '第一篇报道', sourceName: '官媒', sourceTier: 'state_media', publishedAt: '2026-07-19T01:00:00.000Z' },
    ],
    reasoningSummary: [],
    cached: false,
  };
}

describe('market opinion email references', () => {
  it('appends only cited sources in reference-number order with readable links', () => {
    const content = appendReferenceArticles(report());
    expect(content).toContain('## 参考文章');
    expect(content).toContain('[阅读全文](https://example.com/news/3)');
    expect(content).toContain('原始来源未提供可访问链接');
    expect(content).not.toContain('未引用报道');
    expect(content.indexOf('[N1]')).toBeLessThan(content.lastIndexOf('[N3]'));
  });

  it('does not append an empty section when the report has no citations', () => {
    const value = report();
    value.content = '没有引用。';
    expect(appendReferenceArticles(value)).toBe('没有引用。');
  });
});
