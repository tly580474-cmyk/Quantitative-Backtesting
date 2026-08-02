import OpenAI from 'openai';

// N3.1：假设生成 LLM Provider。
// 能力清单（事件引擎白名单策略 + 因子库 + 指标注册表）作为 prompt 的能力边界；
// 模型只被允许在能力边界内产出假设，非法能力引用由 generator 层拒绝（防幻觉）。
// 兼容 OpenAI / DeepSeek 等 Chat Completions JSON 输出。

export interface HypothesisLlmRequest {
  /** 能力清单上下文（结构化 JSON 文本） */
  capabilityContext: string;
  /** 可选研究方向提示词 */
  prompt?: string;
  /** 期望生成条数 */
  count: number;
  model?: string;
}

export interface HypothesisLlmProvider {
  generateHypotheses(request: HypothesisLlmRequest): Promise<unknown>;
}

const SYSTEM_PROMPT = [
  '你是量化研究假设生成助手。你的产出必须严格限定在给定能力清单内，',
  '只能引用清单中存在的策略类型与参数范围，不得发明不存在的能力。',
  '只返回 JSON，格式：{"hypotheses":[{"name":"假设名称","description":"假设描述",',
  '"strategyType":"策略类型","params":{...},"rationale":"生成理由"}]}。',
  '每个假设的 params 必须与策略类型声明的参数 Schema 一致。',
].join('');

export class OpenAIHypothesisProvider implements HypothesisLlmProvider {
  private client: OpenAI;
  private model: string;

  constructor(apiKey: string, baseURL: string, model: string, timeoutMs = 60_000) {
    this.client = new OpenAI({ apiKey, baseURL, timeout: timeoutMs, maxRetries: 1 });
    this.model = model;
  }

  async generateHypotheses(request: HypothesisLlmRequest): Promise<unknown> {
    const model = request.model || this.model;
    const userPrompt = [
      `能力清单：\n${request.capabilityContext}`,
      request.prompt ? `研究方向：${request.prompt}` : '',
      `请生成 ${request.count} 条可检验的研究假设。`,
    ].filter(Boolean).join('\n\n');
    const response = await this.client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.7,
      max_tokens: 4096,
    });
    const text = response.choices[0]?.message?.content;
    if (!text) throw new Error('模型返回了空响应');
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('模型返回了无效 JSON');
    }
  }
}

/** 确定性 Mock：不依赖外部 API，供未配置 key 时与测试使用。 */
export class MockHypothesisProvider implements HypothesisLlmProvider {
  async generateHypotheses(request: HypothesisLlmRequest): Promise<unknown> {
    const count = Math.min(request.count, 5);
    return {
      hypotheses: Array.from({ length: count }, (_, index) => {
        const fast = 5 + index * 5;
        const slow = fast * 4;
        return {
          name: `双均线交叉 ${fast}/${slow} 日`,
          description: `假设：短期均线（${fast} 日）上穿长期均线（${slow} 日）时买入，下穿时卖出，可在所选标的上捕获趋势行情。`,
          strategyType: 'dual_ma',
          params: { fast, slow },
          rationale: `基于能力清单中的双均线交叉策略（黄金样例已锁定）：${fast}/${slow} 周期组合在 A 股日线上检验趋势跟踪有效性。`,
        };
      }),
    };
  }
}
