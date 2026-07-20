import { describe, expect, it, vi } from 'vitest';
import type { MarketNewsItem, MarketNewsSnapshot } from '../marketData/marketNewsTypes.js';
import type { MarketOpinionMarketContext } from './marketOpinionAgent.js';
import { collectFreshMarketOpinionInputs } from './marketOpinionPushService.js';
import { assertFreshMarketOpinionInputs } from './marketOpinionFreshness.js';

const NOW = new Date('2026-07-20T04:00:00.000Z');

function item(sourceKey: 'cls' | 'xinwenlianbo', sourceTier: 'professional' | 'state_media'): MarketNewsItem {
  return {
    newsId: `${sourceKey}-1`,
    sourceKey,
    sourceName: sourceKey,
    sourceTier,
    contentType: 'flash',
    title: `${sourceKey} news`,
    publishedAt: '2026-07-20T03:55:00.000Z',
    canonicalHash: `${sourceKey}-hash`,
  };
}

function snapshot(overrides: Partial<MarketNewsSnapshot> = {}): MarketNewsSnapshot {
  return {
    items: [item('cls', 'professional'), item('xinwenlianbo', 'state_media')],
    total: 2,
    updatedAt: '2026-07-20T03:59:00.000Z',
    sources: ['cls', 'xinwenlianbo'],
    ...overrides,
  };
}

function context(overrides: Partial<MarketOpinionMarketContext> = {}): MarketOpinionMarketContext {
  return {
    capturedAt: '2026-07-20T03:59:30.000Z',
    session: '2026-07-20 lunch',
    dataTradeDate: '2026-07-20',
    indices: [{ code: '000001', updatedAt: '2026-07-20T03:59:20.000Z' }],
    sentiment: { updatedAt: '2026-07-20T03:59:10.000Z' },
    capitalFlow: { updatedAt: '2026-07-20T03:59:05.000Z', stale: false },
    hotSectors: { snapshotTime: '2026-07-20T03:59:00.000Z', stale: false },
    unavailable: [],
    ...overrides,
  };
}

describe('market opinion freshness gate', () => {
  it('accepts a fresh multi-source news and market snapshot', () => {
    expect(() => assertFreshMarketOpinionInputs({
      news: snapshot().items,
      newsSnapshot: snapshot(),
      context: context(),
    }, NOW)).not.toThrow();
  });

  it('rejects stale or single-source news instead of allowing a database fallback', () => {
    expect(() => assertFreshMarketOpinionInputs({
      news: [item('cls', 'professional')],
      newsSnapshot: snapshot({
        items: [item('cls', 'professional')],
        sources: ['cls'],
        updatedAt: '2026-07-20T03:40:00.000Z',
      }),
      context: context(),
    }, NOW)).toThrow(/新闻采集快照已陈旧 20 分钟.*仅有 1 个有效来源/);
  });

  it('rejects stale market fallbacks and unavailable context', () => {
    expect(() => assertFreshMarketOpinionInputs({
      news: snapshot().items,
      newsSnapshot: snapshot(),
      context: context({
        unavailable: ['指数行情'],
        capitalFlow: { updatedAt: '2026-07-20T03:59:05.000Z', stale: true, fallbackReason: 'source timeout' },
      }),
    }, NOW)).toThrow(/行情上下文缺失：指数行情.*主力资金使用了陈旧缓存/);
  });

  it('accepts the latest completed trading-day snapshot before the market opens', () => {
    expect(() => assertFreshMarketOpinionInputs({
      news: snapshot().items,
      newsSnapshot: snapshot(),
      context: context({
        session: '2026-07-20 pre_open',
        dataTradeDate: '2026-07-17',
        capitalFlow: {
          updatedAt: '2026-07-17T07:10:00.000Z', tradeDate: '2026-07-17', stale: true,
          fallbackReason: '盘前暂无当日资金流样本',
        },
        hotSectors: {
          snapshotTime: '2026-07-17T07:10:00.000Z', dataTradeDate: '2026-07-17', stale: true,
          fallbackReason: '盘前暂无当日板块样本',
        },
      }),
    }, NOW)).not.toThrow();
  });

  it('propagates refresh errors and never builds a context from old news', async () => {
    const buildContext = vi.fn(async () => context());
    const loadRecentNews = vi.fn(async () => snapshot().items);
    await expect(collectFreshMarketOpinionInputs(NOW, undefined, {
      refreshNews: vi.fn(async () => { throw new Error('all sources unavailable'); }),
      loadRecentNews,
      buildContext,
    })).rejects.toThrow('all sources unavailable');
    expect(buildContext).not.toHaveBeenCalled();
    expect(loadRecentNews).not.toHaveBeenCalled();
  });

  it('loads the complete 72-hour pool after a fresh Monday refresh, including weekend events', async () => {
    const checkedAt = new Date();
    const weekend = {
      ...item('cls', 'professional'),
      newsId: 'weekend-policy',
      title: '周末发布重大产业政策，涉及投资100亿元',
      publishedAt: new Date(checkedAt.getTime() - 36 * 60 * 60_000).toISOString(),
    };
    const freshSnapshot = snapshot({
      updatedAt: checkedAt.toISOString(),
      items: snapshot().items.map((entry) => ({ ...entry, publishedAt: checkedAt.toISOString() })),
    });
    const freshContext = context({
      capturedAt: checkedAt.toISOString(),
      indices: [{ code: '000001', updatedAt: checkedAt.toISOString() }],
      sentiment: { updatedAt: checkedAt.toISOString() },
      capitalFlow: { updatedAt: checkedAt.toISOString(), stale: false },
      hotSectors: { snapshotTime: checkedAt.toISOString(), stale: false },
    });
    const inputs = await collectFreshMarketOpinionInputs(checkedAt, undefined, {
      refreshNews: vi.fn(async () => freshSnapshot),
      loadRecentNews: vi.fn(async () => [...freshSnapshot.items, weekend]),
      buildContext: vi.fn(async () => freshContext),
    });
    expect(inputs.news.some((entry) => entry.newsId === 'weekend-policy')).toBe(true);
  });
});
