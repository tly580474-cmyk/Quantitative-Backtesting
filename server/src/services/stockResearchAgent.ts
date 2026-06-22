import OpenAI from 'openai';
import type { KlinePoint, ResearchReport, StockQuote } from '../marketData/aStockDataService.js';

export interface StockResearchContext {
  quote: StockQuote;
  daily: KlinePoint[];
  weekly: KlinePoint[];
  reports: ResearchReport[];
  question?: string;
}

export class StockResearchAgent {
  private client: OpenAI | null;

  constructor(
    apiKey: string,
    baseURL: string,
    private model: string,
    timeoutMs: number,
  ) {
    this.client = apiKey ? new OpenAI({ apiKey, baseURL, timeout: timeoutMs, maxRetries: 1 }) : null;
  }

  async research(context: StockResearchContext, requestedModel?: string): Promise<{ content: string; model: string; sources: string[]; reasoningSummary: string[] }> {
    if (!this.client) throw new Error('AI 模型尚未配置');
    const model = requestedModel || this.model;
    const prompt = `请基于以下结构化数据，对 ${context.quote.name}(${context.quote.code}) 做一份简洁、审慎的中文调研报告。
用户关注：${context.question || '基本面估值、走势、机构观点与主要风险'}

实时行情：${JSON.stringify(context.quote)}
最近日K（最多60根）：${JSON.stringify(context.daily.slice(-60))}
最近周K（最多52根）：${JSON.stringify(context.weekly.slice(-52))}
机构研报：${JSON.stringify(context.reports.slice(0, 12))}

严格遵循：
1. 只基于给定数据，不编造财务指标、事件或研报观点；缺失项明确写“数据不足”。
2. 结构包含：行情速览、估值观察、趋势观察、机构覆盖、风险清单、后续验证项。
3. 区分事实与推断；不要给确定性收益承诺，不输出直接买卖指令。
4. 引用研报时写机构与日期。用 Markdown 输出。`;
    const response = await this.client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: '你是 A 股调研 Agent。数据源优先级为腾讯行情、通达信 K 线、东财研报；你的工作是整理证据，不是预测价格。' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.2,
      max_tokens: 5000,
    });
    const content = response.choices[0]?.message?.content?.trim();
    if (!content) throw new Error('模型返回了空调研结果');
    return {
      content,
      model,
      sources: ['腾讯财经实时行情', '腾讯财经前复权K线', '东方财富研报'],
      reasoningSummary: [
        `读取 ${context.quote.name}(${context.quote.code}) 的实时价格、估值和市值字段。`,
        `检查 ${context.daily.length} 根日K与 ${context.weekly.length} 根周K，比较近期趋势和波动。`,
        `整理 ${context.reports.length} 篇机构研报的日期、机构、评级与标题。`,
        '要求模型区分数据事实与推断，并标记数据缺口。',
        '按行情、估值、趋势、机构观点、风险和验证项组织 Markdown 报告。',
      ],
    };
  }
}
