import OpenAI from 'openai';
import type {
  StrategyGenerationProvider,
  GenerateStrategyRequest,
  GenerateStrategyResult,
  RefineStrategyRequest,
  ExplainStrategyRequest,
  StrategyExplanation,
} from './provider.js';
import { DSL_CONTRACT, SYSTEM_PROMPT, USER_PROMPT_TEMPLATE } from './prompts.js';
import {
  explanationSchema,
  formatValidationErrors,
  normalizeStrategyCandidate,
  strategyDocumentSchema,
  StrategyOutputValidationError,
} from './schema.js';

/**
 * OpenAI-compatible strategy generation provider.
 * Works with OpenAI, DeepSeek, and any API that supports
 * Chat Completions with response_format json_object.
 */
export class OpenAIStrategyGenerationProvider implements StrategyGenerationProvider {
  private client: OpenAI;
  private model: string;

  constructor(apiKey: string, baseURL: string, model: string, timeoutMs: number = 60000) {
    this.client = new OpenAI({
      apiKey,
      baseURL,
      timeout: timeoutMs,
      maxRetries: 1,
    });
    this.model = model;
  }

  async generate(request: GenerateStrategyRequest): Promise<GenerateStrategyResult> {
    const id = crypto.randomUUID();
    const model = request.model || this.model;
    const rawStrategy = await this.requestJson(
      model,
      SYSTEM_PROMPT,
      USER_PROMPT_TEMPLATE(request.prompt, request.dslVersion),
    );
    const strategy = await this.validateAndRepair(rawStrategy, model, id);

    return {
      generationId: id,
      strategy,
      summary: `基于 ${model} 生成的策略`,
      warnings: ['AI 生成策略仅供参考，请在信号预览中验证。'],
      requiresConfirmation: true,
    };
  }

  async refine(request: RefineStrategyRequest): Promise<GenerateStrategyResult> {
    const id = crypto.randomUUID();
    const model = request.model || this.model;
    const rawStrategy = await this.requestJson(
      model,
      SYSTEM_PROMPT,
      `当前策略 DSL:\n${JSON.stringify(request.currentStrategy, null, 2)}\n\n修改要求: ${request.modification}\n\n${DSL_CONTRACT}\n\n只返回修改后的完整策略 JSON。`,
    );
    const strategy = await this.validateAndRepair(rawStrategy, model, id);

    return {
      generationId: id,
      strategy,
      summary: `已根据 "${request.modification}" 调整策略。`,
      warnings: [],
      requiresConfirmation: true,
    };
  }

  async explain(request: ExplainStrategyRequest): Promise<StrategyExplanation> {
    const result = await this.requestJson(
      this.model,
      '你是量化策略解释助手，只返回 JSON。',
      `请用中文解释以下量化策略。返回严格 JSON：{"explanation":"总体逻辑","risks":["风险1"],"parameterNotes":"参数说明"}。\n\n${JSON.stringify(request.strategy, null, 2)}`,
      4096,
    );
    const parsed = explanationSchema.safeParse(result);
    if (!parsed.success) {
      throw new StrategyOutputValidationError(formatValidationErrors(parsed.error));
    }
    return parsed.data;
  }

  private async requestJson(
    model: string,
    systemPrompt: string,
    userPrompt: string,
    maxTokens = 16384,
  ): Promise<unknown> {
    const response = await this.client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.2,
      max_tokens: maxTokens,
    });
    const text = response.choices[0]?.message?.content;
    if (!text) throw new Error('模型返回了空响应');
    try {
      return JSON.parse(text);
    } catch {
      throw new StrategyOutputValidationError(['root: 模型返回了无效 JSON']);
    }
  }

  private async validateAndRepair(
    candidate: unknown,
    model: string,
    generationId: string,
  ): Promise<Record<string, unknown>> {
    const normalizedCandidate = normalizeStrategyCandidate(candidate, generationId);
    const first = strategyDocumentSchema.safeParse(normalizedCandidate);
    if (first.success) return this.attachGenerationMetadata(first.data, generationId);

    const errors = formatValidationErrors(first.error);
    const repaired = await this.requestJson(
      model,
      `${SYSTEM_PROMPT}\n${DSL_CONTRACT}`,
      `下面的策略 JSON 未通过校验。请只修复结构和类型错误，不改变策略意图。\n\n校验错误:\n${errors.join('\n')}\n\n待修复 JSON:\n${JSON.stringify(normalizedCandidate, null, 2)}\n\n只返回修复后的完整 JSON。`,
    );
    const second = strategyDocumentSchema.safeParse(normalizeStrategyCandidate(repaired, generationId));
    if (!second.success) {
      throw new StrategyOutputValidationError(formatValidationErrors(second.error));
    }
    return this.attachGenerationMetadata(second.data, generationId);
  }

  private attachGenerationMetadata(
    strategy: Record<string, unknown>,
    generationId: string,
  ): Record<string, unknown> {
    const metadata = strategy.metadata as Record<string, unknown>;
    return {
      ...strategy,
      metadata: {
        ...metadata,
        source: 'ai',
        aiGenerationId: generationId,
      },
    };
  }
}
