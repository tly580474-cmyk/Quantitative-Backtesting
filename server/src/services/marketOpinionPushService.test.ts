import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  appendReferenceArticles,
  getMarketSnapshotSemantics,
  summarizePushResult,
  withStageTimeout,
} from './marketOpinionPushService.js';
import type { MarketOpinionReport } from './marketOpinionAgent.js';
import type { FreshMarketOpinionInputs } from './marketOpinionFreshness.js';

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

describe('market opinion stage timeout', () => {
  afterEach(() => vi.useRealTimers());

  it('returns a completed stage result', async () => {
    await expect(withStageTimeout(Promise.resolve('ok'), 100, 'timeout')).resolves.toBe('ok');
  });

  it('fails a stage that exceeds its execution budget', async () => {
    vi.useFakeTimers();
    const result = withStageTimeout(new Promise<never>(() => undefined), 100, '观点生成超时');
    const rejection = expect(result).rejects.toThrow('观点生成超时');
    await vi.advanceTimersByTimeAsync(101);
    await rejection;
  });
});

describe('market opinion delivery details', () => {
  it('retains SMTP acceptance, rejection and server response in the persisted result', () => {
    const inputs = {
      news: [
        { sourceKey: 'cls' },
        { sourceKey: 'cls' },
        { sourceKey: 'eastmoney_global' },
      ],
      newsSnapshot: { updatedAt: '2026-07-22T04:00:16.228Z' },
      context: { capturedAt: '2026-07-22T04:00:38.561Z' },
    } as FreshMarketOpinionInputs;
    const result = summarizePushResult('midday', '财经午报', report(), {
      messageId: '<message@example.com>',
      accepted: ['accepted@example.com'],
      rejected: ['rejected@example.com'],
      response: '250 Mail OK queued',
    }, inputs);

    expect(result).toMatchObject({
      messageId: '<message@example.com>',
      acceptedRecipients: ['accepted@example.com'],
      rejectedRecipients: ['rejected@example.com'],
      smtpResponse: '250 Mail OK queued',
      newsSources: ['cls', 'eastmoney_global'],
    });
  });
});

describe('market snapshot time ownership', () => {
  it('labels a Monday 09:16 quote as the current-session opening auction', () => {
    const semantics = getMarketSnapshotSemantics({
      tradeDate: '2026-07-20', minuteOfDay: 9 * 60 + 16, weekday: 1,
      phase: 'pre_open', isIntradayUpdateWindow: false, isDailyBarFinal: false,
    }, '2026-07-17');
    expect(semantics).toEqual({
      quoteTradeDate: '2026-07-20',
      previousCloseTradeDate: '2026-07-17',
      quotePhase: 'opening_auction',
      snapshotType: 'current_session',
    });
  });

  it('keeps a Monday 09:00 quote in the previous-close reference context', () => {
    const semantics = getMarketSnapshotSemantics({
      tradeDate: '2026-07-20', minuteOfDay: 9 * 60, weekday: 1,
      phase: 'pre_open', isIntradayUpdateWindow: false, isDailyBarFinal: false,
    }, '2026-07-17');
    expect(semantics.quoteTradeDate).toBe('2026-07-17');
    expect(semantics.quotePhase).toBe('pre_open_reference');
    expect(semantics.snapshotType).toBe('previous_close_reference');
  });
});
