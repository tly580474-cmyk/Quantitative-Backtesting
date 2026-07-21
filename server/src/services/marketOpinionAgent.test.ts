import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MarketNewsItem, NewsSourceTier } from '../marketData/marketNewsTypes.js';
import {
  MarketOpinionAgent,
  buildDigestPrompt,
  buildMarketOpinionPrompt,
  selectOpinionNews,
  withStageTimeout,
} from './marketOpinionAgent.js';

// 用 vi.hoisted 提升 mock 引用，保证 vi.mock 工厂能拿到同一份 vi.fn
const mocks = vi.hoisted(() => ({
  create: vi.fn(),
}));

vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: mocks.create } };
  },
}));

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

// 运行态治理：与 PushService 的并发守护、状态记录、阶段回调、阶段超时对齐
describe('market opinion agent runtime governance', () => {
  beforeEach(() => {
    mocks.create.mockReset();
    mocks.create.mockResolvedValue({ choices: [{ message: { content: '## 核心结论\n测试观点[N1]' } }] });
  });

  it('status() reports configured=false and no run history when constructed without api key', () => {
    const agent = new MarketOpinionAgent('', 'http://fake', 'model', 1000);
    expect(agent.status()).toEqual({
      configured: false,
      model: 'model',
      running: false,
    });
  });

  it('records lastError and clears running when generate fails on unconfigured client', async () => {
    const agent = new MarketOpinionAgent('', 'http://fake', 'model', 1000);
    await expect(agent.generate([item('1', 'state_media')])).rejects.toThrow('AI 模型尚未配置');
    const status = agent.status();
    expect(status.running).toBe(false);
    expect(status.lastError?.message).toBe('AI 模型尚未配置');
    expect(status.lastSuccess).toBeUndefined();
  });

  it('rejects concurrent generate calls while one is in flight', async () => {
    const agent = new MarketOpinionAgent('fake-key', 'http://fake', 'model', 1000);
    let releaseFirst!: () => void;
    const blocker = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const firstCall = agent.generate([item('1', 'state_media')], undefined, false, {
      onStage: () => blocker,
    });
    // 首次调用已同步进入 running 状态，并在 onStage('selecting') 处挂起
    await expect(agent.generate([item('2', 'state_media')])).rejects.toThrow('已有市场观点解读正在生成');
    expect(agent.status().running).toBe(true);

    releaseFirst();
    const report = await firstCall;
    expect(report.content).toContain('测试观点');
    expect(agent.status().running).toBe(false);
    expect(agent.status().lastSuccess?.newsCount).toBe(1);
  });

  it('fires selecting and calling_model stages before a model failure, and records lastError', async () => {
    const agent = new MarketOpinionAgent('fake-key', 'http://fake', 'model', 1000);
    mocks.create.mockRejectedValueOnce(new Error('upstream 502'));
    const stages: string[] = [];
    await expect(agent.generate([item('1', 'state_media')], undefined, false, {
      onStage: (stage) => { stages.push(stage); },
    })).rejects.toThrow('upstream 502');
    expect(stages).toEqual(['selecting', 'calling_model']);
    expect(agent.status().lastError?.message).toBe('upstream 502');
    expect(agent.status().running).toBe(false);
  });

  it('records lastSuccess and fires all four stages on a successful generate', async () => {
    const agent = new MarketOpinionAgent('fake-key', 'http://fake', 'model', 1000);
    const stages: string[] = [];
    const report = await agent.generate([item('1', 'state_media')], undefined, false, {
      onStage: (stage) => { stages.push(stage); },
    });
    expect(report.content).toContain('测试观点');
    expect(stages).toEqual(['selecting', 'calling_model', 'parsing', 'done']);
    const status = agent.status();
    expect(status.running).toBe(false);
    expect(status.lastSuccess?.newsCount).toBe(1);
    expect(status.lastSuccess?.cached).toBe(false);
    expect(status.lastError).toBeUndefined();
  });

  it('generateDigest also guards concurrency and records lastError on failure', async () => {
    const agent = new MarketOpinionAgent('fake-key', 'http://fake', 'model', 1000);
    mocks.create.mockRejectedValueOnce(new Error('digest upstream 500'));
    const stages: string[] = [];
    await expect(agent.generateDigest(
      [item('1', 'state_media')],
      'midday',
      { capturedAt: '2026-07-20T04:00:00.000Z', session: '2026-07-20 midday', unavailable: [] },
      undefined,
      { onStage: (stage) => { stages.push(stage); } },
    )).rejects.toThrow('digest upstream 500');
    expect(stages).toEqual(['selecting', 'calling_model']);
    expect(agent.status().lastError?.message).toBe('digest upstream 500');
    expect(agent.status().running).toBe(false);
  });

  it('serves cached report without re-calling the model and still emits done stage', async () => {
    const agent = new MarketOpinionAgent('fake-key', 'http://fake', 'model', 1000);
    const firstStages: string[] = [];
    await agent.generate([item('1', 'state_media')], undefined, false, {
      onStage: (stage) => { firstStages.push(stage); },
    });
    expect(mocks.create).toHaveBeenCalledTimes(1);

    const secondStages: string[] = [];
    const cached = await agent.generate([item('1', 'state_media')], undefined, false, {
      onStage: (stage) => { secondStages.push(stage); },
    });
    expect(mocks.create).toHaveBeenCalledTimes(1); // 不会再次调用模型
    expect(cached.cached).toBe(true);
    expect(secondStages).toEqual(['selecting', 'done']);
    expect(agent.status().lastSuccess?.cached).toBe(true);
  });
});

describe('market opinion agent stage timeout', () => {
  afterEach(() => vi.useRealTimers());

  it('returns a completed result', async () => {
    await expect(withStageTimeout(Promise.resolve('ok'), 100, 'timeout')).resolves.toBe('ok');
  });

  it('fails a stage that exceeds its execution budget', async () => {
    vi.useFakeTimers();
    const result = withStageTimeout(new Promise<never>(() => undefined), 100, '模型调用超过 90 秒');
    const rejection = expect(result).rejects.toThrow('模型调用超过 90 秒');
    await vi.advanceTimersByTimeAsync(101);
    await rejection;
  });
});
