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
    chat = { completions: { create: async (...args: unknown[]) => {
      const response = await mocks.create(...args);
      return (async function* stream() {
        const content = response?.choices?.[0]?.message?.content ?? '';
        if (content) yield { choices: [{ finish_reason: null, delta: { content } }] };
        yield { choices: [{ finish_reason: 'stop', delta: {} }] };
      }());
    } } };
  },
}));

function item(id: string, tier: NewsSourceTier, publishedAt = new Date().toISOString()): MarketNewsItem {
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

describe('market opinion agent fallback model', () => {
  beforeEach(() => {
    mocks.create.mockReset();
    mocks.create.mockResolvedValue({ choices: [{ message: { content: '## 核心结论\n测试观点[N1]' } }] });
  });

  it('status() reports the fallback model when configured', () => {
    const agent = new MarketOpinionAgent('fake-key', 'http://fake', 'primary', 1000, 'backup');
    expect(agent.status().fallbackModel).toBe('backup');
  });

  it('streams DeepSeek V4 output with thinking disabled', async () => {
    const agent = new MarketOpinionAgent('fake-key', 'https://api.deepseek.com/v1', 'deepseek-v4-flash', 1000);

    await agent.generate([item('1', 'state_media')]);

    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.create.mock.calls[0]![0]).toMatchObject({
      model: 'deepseek-v4-flash',
      stream: true,
      thinking: { type: 'disabled' },
    });
  });

  it('streams other providers without sending the DeepSeek-only thinking option', async () => {
    const agent = new MarketOpinionAgent('fake-key', 'https://example.com/v1', 'other-model', 1000);

    await agent.generate([item('1', 'state_media')]);

    expect(mocks.create.mock.calls[0]![0]).toMatchObject({ model: 'other-model', stream: true });
    expect(mocks.create.mock.calls[0]![0]).not.toHaveProperty('thinking');
  });

  it('status() omits fallbackModel when not configured', () => {
    const agent = new MarketOpinionAgent('fake-key', 'http://fake', 'primary', 1000);
    expect(agent.status().fallbackModel).toBeUndefined();
  });

  it('does not call the fallback model when the primary succeeds', async () => {
    const agent = new MarketOpinionAgent('fake-key', 'http://fake', 'primary', 1000, 'backup');
    const report = await agent.generateDigest(
      [item('1', 'state_media')],
      'midday',
      { capturedAt: '2026-07-20T04:00:00.000Z', session: '2026-07-20 midday', unavailable: [] },
    );
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.create.mock.calls[0]![0]).toMatchObject({ model: 'primary' });
    expect(report.model).toBe('primary');
  });

  it('falls back to the backup model when the primary returns empty content', async () => {
    const agent = new MarketOpinionAgent('fake-key', 'http://fake', 'primary', 1000, 'backup');
    mocks.create
      .mockResolvedValueOnce({ choices: [{ message: { content: '' } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: '## 核心结论\n备用观点[N1]' } }] });
    const report = await agent.generateDigest(
      [item('1', 'state_media')],
      'midday',
      { capturedAt: '2026-07-20T04:00:00.000Z', session: '2026-07-20 midday', unavailable: [] },
    );
    expect(mocks.create).toHaveBeenCalledTimes(2);
    expect(mocks.create.mock.calls[0]![0]).toMatchObject({ model: 'primary' });
    expect(mocks.create.mock.calls[1]![0]).toMatchObject({ model: 'backup' });
    expect(report.model).toBe('backup');
    expect(report.content).toContain('备用观点');
  });

  it('falls back to the backup model when the primary throws an API error', async () => {
    const agent = new MarketOpinionAgent('fake-key', 'http://fake', 'primary', 1000, 'backup');
    mocks.create
      .mockRejectedValueOnce(new Error('upstream 502'))
      .mockResolvedValueOnce({ choices: [{ message: { content: '## 核心结论\n备用观点[N1]' } }] });
    const report = await agent.generateDigest(
      [item('1', 'state_media')],
      'midday',
      { capturedAt: '2026-07-20T04:00:00.000Z', session: '2026-07-20 midday', unavailable: [] },
    );
    expect(mocks.create).toHaveBeenCalledTimes(2);
    expect(report.model).toBe('backup');
    expect(report.content).toContain('备用观点');
  });

  it('throws a combined error when both primary and fallback fail', async () => {
    const agent = new MarketOpinionAgent('fake-key', 'http://fake', 'primary', 1000, 'backup');
    mocks.create
      .mockRejectedValueOnce(new Error('primary 500'))
      .mockRejectedValueOnce(new Error('backup 500'));
    await expect(agent.generateDigest(
      [item('1', 'state_media')],
      'midday',
      { capturedAt: '2026-07-20T04:00:00.000Z', session: '2026-07-20 midday', unavailable: [] },
    )).rejects.toThrow('主模型(primary)与备用模型(backup)均失败');
    expect(mocks.create).toHaveBeenCalledTimes(2);
  });

  it('does not fall back when no fallback model is configured', async () => {
    const agent = new MarketOpinionAgent('fake-key', 'http://fake', 'primary', 1000);
    mocks.create.mockResolvedValueOnce({ choices: [{ message: { content: '' } }] });
    await expect(agent.generateDigest(
      [item('1', 'state_media')],
      'midday',
      { capturedAt: '2026-07-20T04:00:00.000Z', session: '2026-07-20 midday', unavailable: [] },
    )).rejects.toThrow('模型返回了空的市场观点报告');
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });

  it('does not fall back when the fallback equals the primary model', async () => {
    const agent = new MarketOpinionAgent('fake-key', 'http://fake', 'primary', 1000, 'primary');
    mocks.create.mockResolvedValueOnce({ choices: [{ message: { content: '' } }] });
    await expect(agent.generateDigest(
      [item('1', 'state_media')],
      'midday',
      { capturedAt: '2026-07-20T04:00:00.000Z', session: '2026-07-20 midday', unavailable: [] },
    )).rejects.toThrow('模型返回了空的市场观点报告');
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });

  it('also applies fallback in generate() when the primary returns empty', async () => {
    const agent = new MarketOpinionAgent('fake-key', 'http://fake', 'primary', 1000, 'backup');
    mocks.create
      .mockResolvedValueOnce({ choices: [{ message: { content: '' } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: '## 核心结论\n备用观点[N1]' } }] });
    const report = await agent.generate([item('1', 'state_media')]);
    expect(report.model).toBe('backup');
    expect(report.content).toContain('备用观点');
  });

  it('accepts a fallback config object with a separate provider baseURL/apiKey', async () => {
    const agent = new MarketOpinionAgent('primary-key', 'https://primary.example.com/v1', 'primary', 1000, {
      model: 'backup',
      baseURL: 'https://backup.example.com/v1',
      apiKey: 'backup-key',
    });
    // 备用模型标记为独立供应商
    expect(agent.status().fallbackModel).toBe('backup');
    expect(agent.status().fallbackProviderSeparate).toBe(true);

    mocks.create
      .mockResolvedValueOnce({ choices: [{ message: { content: '' } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: '## 核心结论\n跨供应商备用[N1]' } }] });
    const report = await agent.generateDigest(
      [item('1', 'state_media')],
      'midday',
      { capturedAt: '2026-07-20T04:00:00.000Z', session: '2026-07-20 midday', unavailable: [] },
    );
    expect(mocks.create).toHaveBeenCalledTimes(2);
    expect(mocks.create.mock.calls[0]![0]).toMatchObject({ model: 'primary' });
    expect(mocks.create.mock.calls[1]![0]).toMatchObject({ model: 'backup' });
    expect(report.model).toBe('backup');
  });

  it('marks fallbackProviderSeparate=false when fallback reuses the primary provider', () => {
    const agent = new MarketOpinionAgent('primary-key', 'https://primary.example.com/v1', 'primary', 1000, {
      model: 'backup',
    });
    expect(agent.status().fallbackModel).toBe('backup');
    expect(agent.status().fallbackProviderSeparate).toBe(false);
  });

  it('does not enable fallback when the config object has an empty model', () => {
    const agent = new MarketOpinionAgent('primary-key', 'https://primary.example.com/v1', 'primary', 1000, {
      model: '',
      baseURL: 'https://backup.example.com/v1',
      apiKey: 'backup-key',
    });
    expect(agent.status().fallbackModel).toBeUndefined();
  });

  it('does not enable fallback when the primary client is unconfigured (no apiKey)', () => {
    const agent = new MarketOpinionAgent('', 'https://primary.example.com/v1', 'primary', 1000, {
      model: 'backup',
      baseURL: 'https://backup.example.com/v1',
      apiKey: 'backup-key',
    });
    expect(agent.status().configured).toBe(false);
    expect(agent.status().fallbackModel).toBeUndefined();
  });

  it('forceFallback skips the primary and calls only the fallback model', async () => {
    const agent = new MarketOpinionAgent('fake-key', 'http://fake', 'primary', 1000, 'backup');
    mocks.create.mockResolvedValue({ choices: [{ message: { content: '## 核心结论\n仅备用[N1]' } }] });
    const report = await agent.generateDigest(
      [item('1', 'state_media')],
      'midday',
      { capturedAt: '2026-07-20T04:00:00.000Z', session: '2026-07-20 midday', unavailable: [] },
      undefined,
      { forceFallback: true },
    );
    // 主模型一次都不应被调用
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.create.mock.calls[0]![0]).toMatchObject({ model: 'backup' });
    expect(report.model).toBe('backup');
    expect(report.content).toContain('仅备用');
  });

  it('forceFallback throws a clear error when no fallback is configured', async () => {
    const agent = new MarketOpinionAgent('fake-key', 'http://fake', 'primary', 1000);
    await expect(agent.generateDigest(
      [item('1', 'state_media')],
      'midday',
      { capturedAt: '2026-07-20T04:00:00.000Z', session: '2026-07-20 midday', unavailable: [] },
      undefined,
      { forceFallback: true },
    )).rejects.toThrow('未配置有效的备用模型');
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('forceFallback surfaces the fallback error without mentioning primary', async () => {
    const agent = new MarketOpinionAgent('fake-key', 'http://fake', 'primary', 1000, 'backup');
    mocks.create.mockRejectedValue(new Error('backup 503'));
    await expect(agent.generateDigest(
      [item('1', 'state_media')],
      'midday',
      { capturedAt: '2026-07-20T04:00:00.000Z', session: '2026-07-20 midday', unavailable: [] },
      undefined,
      { forceFallback: true },
    )).rejects.toThrow('备用模型(backup)调用失败：backup 503');
    expect(mocks.create).toHaveBeenCalledTimes(1);
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
