import { describe, expect, it, vi } from 'vitest';
import { buildNonTradingMarketContext, buildMarketContext, MarketOpinionPushService } from './marketOpinionPushService.js';
import { buildDigestPrompt, type MarketOpinionAgent, type MarketOpinionReport } from './marketOpinionAgent.js';
import { assertFreshMarketOpinionInputs, type FreshMarketOpinionInputs } from './marketOpinionFreshness.js';
import type { EmailSender } from './emailSender.js';
import type { StockQuote } from '../marketData/aStockDataService.js';

function fixture(): FreshMarketOpinionInputs {
  const now = new Date().toISOString();
  return {
    news: [{ newsId: '1', canonicalHash: '1', title: '美联储宣布下调利率25个基点', summary: '今日美联储发布决定，联邦基金利率下调25个基点。',
      sourceKey: 'cls', sourceName: '财联社', sourceTier: 'professional', contentType: 'flash', publishedAt: now }],
    newsSnapshot: { items: [], total: 1, updatedAt: now, sources: ['cls', 'xinwenlianbo'] },
    context: { capturedAt: now, session: '2026-10-04 closed', sessionTradeDate: '2026-10-04',
      digestMode: 'non_trading', isTradingDay: false, marketPhase: 'closed', overseasIndices: [], unavailable: ['外盘指数行情'] },
  };
}

function service(mode: 'skip' | 'trading' | 'non_trading') {
  const inputs = fixture();
  const report = { content: '美联储利率变化[N1]', generatedAt: new Date().toISOString(), newsCount: 1, sourceCount: 1,
    sources: [{ ref: 'N1', title: inputs.news[0]!.title, sourceName: '财联社', sourceTier: 'professional', publishedAt: inputs.news[0]!.publishedAt }] } as MarketOpinionReport;
  const generateDigest = vi.fn().mockResolvedValue(report);
  const send = vi.fn().mockResolvedValue({ messageId: 'mock', accepted: ['mock@example.com'], rejected: [] });
  const collectInputs = vi.fn().mockResolvedValue(inputs);
  const resolveDayMode = vi.fn().mockResolvedValue(mode);
  const instance = new MarketOpinionPushService({ enabled: true, skipNonTradingDays: mode === 'skip',
    schedules: { morning: '09:00', midday: '12:00', close: '16:00' }, recipientCount: 1, model: 'mock',
    agent: { generateDigest } as unknown as MarketOpinionAgent,
    email: { send, isConfigured: () => true } as unknown as EmailSender, collectInputs, resolveDayMode });
  return { instance, inputs, collectInputs, generateDigest, send, resolveDayMode };
}

describe('non-trading-day digest delivery', () => {
  it('returns skipped before collection, model or SMTP and exposes the active option', async () => {
    const test = service('skip');
    await expect(test.instance.send('midday', new Date('2026-10-04T04:00:00Z'))).resolves.toMatchObject({
      skipped: true, reason: 'non_trading_day', tradeDate: '2026-10-04', kind: 'midday',
    });
    expect(test.collectInputs).not.toHaveBeenCalled();
    expect(test.generateDigest).not.toHaveBeenCalled();
    expect(test.send).not.toHaveBeenCalled();
    expect(test.instance.status()).toMatchObject({ skipNonTradingDays: true, running: false });
  });

  it('delivers overseas/news reports for all three slots when skipping is disabled', async () => {
    const test = service('non_trading');
    for (const kind of ['morning', 'midday', 'close'] as const) {
      await test.instance.send(kind);
      expect(test.collectInputs).toHaveBeenLastCalledWith(expect.any(Date), undefined, { buildContext: buildNonTradingMarketContext });
      expect(test.generateDigest).toHaveBeenLastCalledWith(test.inputs.news, kind, test.inputs.context, 'mock');
      expect(test.send).toHaveBeenLastCalledWith(expect.objectContaining({ subject: expect.stringContaining('非交易日外盘与新闻') }));
    }
    expect(test.send).toHaveBeenCalledTimes(3);
    expect(test.instance.status().skipNonTradingDays).toBe(false);
  });

  it('keeps the ordinary market context for a trading day', async () => {
    const test = service('trading');
    await test.instance.send('close');
    expect(test.collectInputs).toHaveBeenCalledWith(expect.any(Date), undefined, { buildContext: buildMarketContext });
  });

  it('does not send if calendar resolution fails and releases the running guard', async () => {
    const test = service('non_trading');
    test.resolveDayMode.mockRejectedValue(new Error('交易日历缺失'));
    await expect(test.instance.send('midday')).rejects.toThrow('交易日历缺失');
    expect(test.send).not.toHaveBeenCalled();
    expect(test.instance.status()).toMatchObject({ running: false, lastError: { message: '交易日历缺失' } });
  });
});

describe('holiday evidence and prompt', () => {
  it('omits A-share context and keeps foreign quote timestamps unknown rather than using fetch time', async () => {
    const load = vi.fn().mockResolvedValue([
      { code: '000001', market: 'SH', price: 3000 },
      { code: 'SPX', name: '标普500', market: 'US', price: 6000, changePct: 1, updatedAt: new Date().toISOString(), source: ['腾讯财经'] },
      { code: 'NDX', market: 'US', price: null },
    ] as StockQuote[]);
    const context = await buildNonTradingMarketContext(new Date('2026-10-04T04:00:00Z'), load);
    expect(context.overseasIndices).toEqual([expect.objectContaining({ code: 'SPX', quoteTime: null, snapshotType: 'latest_available_reference' })]);
    expect(context.indices).toBeUndefined();
    expect(context.sentiment).toBeUndefined();
    expect(context.capitalFlow).toBeUndefined();
    expect(context.hotSectors).toBeUndefined();
  });

  it('supports fresh news even when overseas feeds are unavailable, but rejects stale or single-source collection', async () => {
    const inputs = fixture();
    inputs.context = await buildNonTradingMarketContext(new Date(), async () => { throw new Error('feed offline'); });
    expect(() => assertFreshMarketOpinionInputs(inputs)).not.toThrow();
    inputs.newsSnapshot.stale = true;
    expect(() => assertFreshMarketOpinionInputs(inputs)).toThrow('陈旧缓存');
    inputs.newsSnapshot.stale = false;
    inputs.newsSnapshot.sources = ['cls'];
    expect(() => assertFreshMarketOpinionInputs(inputs)).toThrow('至少需要 2 个');
    inputs.newsSnapshot.sources = ['cls', 'xinwenlianbo'];
    inputs.context.capturedAt = '2020-01-01T00:00:00Z';
    expect(() => assertFreshMarketOpinionInputs(inputs)).toThrow('外盘采集快照已陈旧');
  });

  it('uses holiday-specific instructions for every slot and forbids invented A-share sessions', () => {
    const inputs = fixture();
    for (const kind of ['morning', 'midday', 'close'] as const) {
      const prompt = buildDigestPrompt(inputs.news, kind, inputs.context);
      expect(prompt).toContain('今日 A 股休市');
      expect(prompt).toContain('高价值新闻');
      expect(prompt).toContain('报价时间未提供');
      expect(prompt).toContain('下一交易日验证清单');
      expect(prompt).not.toContain('以上午真实行情为主');
      expect(prompt).not.toContain('以当日收盘行情为主');
    }
  });
});
