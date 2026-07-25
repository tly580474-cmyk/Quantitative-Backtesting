import { describe, expect, it } from 'vitest';
import {
  buildRelativeStrengthEvidence,
  buildTradingSystemPrompt,
  buildValueInvestmentEvidence,
  resolveTradingStyles,
  TRADING_STYLE_DEFINITIONS,
  type StockResearchContext,
} from './stockResearchAgent.js';

function context(): StockResearchContext {
  return {
    quote: {
      code: '002202',
      name: '金风科技',
      market: 'SZ',
      type: 'stock',
      price: 17.8,
      changeAmount: 0.2,
      changePct: 1.14,
      open: 17.5,
      high: 18,
      low: 17.3,
      previousClose: 17.6,
      limitUp: 19.36,
      limitDown: 15.84,
      turnoverPct: 2.1,
      amplitudePct: 3.98,
      volumeRatio: 1.2,
      amountWan: 80_000,
      peTtm: 23.9,
      peStatic: 20.5,
      pb: 1.87,
      marketCapYi: 742,
      floatMarketCapYi: 610,
      listDate: '2007-12-26',
      industry: '风电设备',
      updatedAt: '2026-07-25T08:00:00.000Z',
      source: ['腾讯财经'],
    },
    daily: [{ date: '2026-07-24', open: 17.5, high: 18, low: 17.3, close: 17.8, volume: 1_000 }],
    weekly: [{ date: '2026-07-24', open: 17, high: 18, low: 16.8, close: 17.8, volume: 5_000 }],
    reports: [{
      title: '风机盈利改善',
      publishDate: '2026-07-24',
      organization: '示例证券',
      rating: '增持',
      industry: '风电设备',
      pdfUrl: 'https://example.com/report.pdf',
      infoCode: 'R1',
    }],
    styles: ['value', 'trend'],
    marketContext: {
      capturedAt: '2026-07-25T08:00:00.000Z',
      session: '2026-07-25 final',
      indices: [
        { name: '中证全指', changePct: -2.21 },
        { name: '沪深300', changePct: -1.67 },
        { name: '中证500', changePct: -2.61 },
      ],
      sentiment: { status: '中性', advancers: 2_600, decliners: 2_400 },
      hotSectors: { items: [{ name: '风电设备', changePct: 2.1 }] },
    },
    marketNews: [{
      newsId: 'market-1',
      sourceKey: 'cls',
      sourceName: '财联社',
      sourceTier: 'professional',
      contentType: 'flash',
      title: '风电行业出现新订单',
      summary: '多家企业披露风电设备订单。',
      publishedAt: '2026-07-25T07:00:00.000Z',
      canonicalHash: 'market-hash',
    }],
    stockNews: [{
      newsId: 'stock-1',
      sourceKey: 'cninfo',
      sourceName: '巨潮资讯',
      sourceTier: 'official',
      contentType: 'announcement',
      title: '公司披露经营公告',
      summary: '公告披露最新经营进展。',
      publishedAt: '2026-07-25T06:00:00.000Z',
      securityCode: '002202',
      canonicalHash: 'stock-hash',
    }],
    marketLayers: {
      fundamental: {
        records: [
          { source: '公司画像与估值', metrics: { dividendYield: 2.86 } },
          { source: '东财核心财务', metrics: { roe: 7.08, eps: 0.75, operatingCashPerShare: 0.61 } },
        ],
      },
      capital: { records: [] },
      signal: { records: [] },
    },
    question: '重点验证趋势与估值能否形成共识',
  };
}

describe('stock intelligent trading system prompt', () => {
  it('keeps the style catalog ordered from conservative to aggressive', () => {
    expect(TRADING_STYLE_DEFINITIONS).toHaveLength(8);
    expect(TRADING_STYLE_DEFINITIONS.map((item) => item.riskLevel))
      .toEqual([1, 2, 2, 3, 3, 4, 4, 5]);
  });

  it('includes only selected styles and separates market, stock and report evidence', () => {
    const prompt = buildTradingSystemPrompt(context());

    expect(prompt).toContain('价值投资派');
    expect(prompt).toContain('趋势跟踪派');
    expect(prompt).not.toContain('成长赛道流');
    expect(prompt).toContain('"ref":"M1"');
    expect(prompt).toContain('"ref":"S1"');
    expect(prompt).toContain('"ref":"R1"');
    expect(prompt).toContain('全市场环境');
    expect(prompt).toContain('条件式交易计划');
  });

  it('resolves styles in catalog risk order instead of request order', () => {
    expect(resolveTradingStyles(['limit-up', 'value']).map((item) => item.value))
      .toEqual(['value', 'limit-up']);
  });

  it('omits the stock-news evidence block when there is no recent stock news', () => {
    const input = context();
    input.stockNews = [];

    const prompt = buildTradingSystemPrompt(input);

    expect(prompt).not.toContain('个股消息与公告证据：');
    expect(prompt).not.toContain('"ref":"S1"');
    expect(prompt).toContain('直接省略个股消息相关内容，不提示缺失');
  });

  it('requires using available breadth and turnover evidence for the market regime', () => {
    const input = context();
    input.marketContext.sentiment = {
      status: '极致恐慌',
      advancers: 515,
      decliners: 4_777,
      totalAmountYi: 19_317.18,
      msi: -61.22,
    };

    const prompt = buildTradingSystemPrompt(input);

    expect(prompt).toContain('"advancers":515');
    expect(prompt).toContain('"decliners":4777');
    expect(prompt).toContain('"totalAmountYi":19317.18');
    expect(prompt).toContain('任一数据块存在有效值，就必须使用已有证据判断');
  });

  it('requires every trading style to compare the stock with the broad market', () => {
    const input = context();

    const evidence = buildRelativeStrengthEvidence(input);
    const prompt = buildTradingSystemPrompt(input);

    expect(evidence.primaryBenchmark).toEqual({ name: '中证全指', changePct: -2.21 });
    expect(evidence.excessVsPrimaryPctPoints).toBe(3.35);
    expect(prompt).toContain('大盘博弈与个股相对强弱');
    expect(prompt).toContain('逆势强、顺势强、市场同步、相对弱');
    expect(prompt).toContain('每个流派的“大盘对比与博弈定位”都必须引用相对强弱证据');
  });

  it('makes dividend yield mandatory when value investing is selected', () => {
    const input = context();

    const evidence = buildValueInvestmentEvidence(input);
    const prompt = buildTradingSystemPrompt(input);

    expect(evidence.dividendYieldPct).toBe(2.86);
    expect(evidence.dividendYieldSource).toBe('公司画像与估值');
    expect(prompt).toContain('价值投资派专项证据');
    expect(prompt).toContain('"dividendYieldPct":2.86');
    expect(prompt).toContain('必须设置“股息与分红质量”小项');
    expect(prompt).toContain('“股息率：X%”或“股息率：待补充”');
  });

  it('does not add the value-investing evidence block for non-value styles', () => {
    const input = context();
    input.styles = ['trend'];

    const prompt = buildTradingSystemPrompt(input);

    expect(prompt).not.toContain('价值投资派专项证据');
    expect(prompt).not.toContain('股息率是必查项');
  });
});
