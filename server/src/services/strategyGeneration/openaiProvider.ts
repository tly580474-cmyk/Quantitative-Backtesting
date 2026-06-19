import OpenAI from 'openai';
import type {
  StrategyGenerationProvider,
  GenerateStrategyRequest,
  GenerateStrategyResult,
  RefineStrategyRequest,
  ExplainStrategyRequest,
  StrategyExplanation,
} from './provider.js';
import { SYSTEM_PROMPT, USER_PROMPT_TEMPLATE } from './prompts.js';

/**
 * OpenAI-powered strategy generation provider.
 * Uses Responses API with Structured Outputs.
 */
export class OpenAIStrategyGenerationProvider implements StrategyGenerationProvider {
  private client: OpenAI;
  private model: string;
  private timeoutMs: number;

  constructor(apiKey: string, model: string, timeoutMs: number = 30000) {
    this.client = new OpenAI({ apiKey, timeout: timeoutMs, maxRetries: 1 });
    this.model = model;
    this.timeoutMs = timeoutMs;
  }

  async generate(request: GenerateStrategyRequest): Promise<GenerateStrategyResult> {
    const id = crypto.randomUUID();

    const response = await this.client.responses.create({
      model: this.model,
      input: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: USER_PROMPT_TEMPLATE(request.prompt, request.dslVersion) },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'strategy_dsl',
          schema: getStrategyJsonSchema(),
          strict: true,
        },
      },
    });

    const strategy = JSON.parse(response.output_text);

    // Validate basic structure
    if (!strategy.schemaVersion || !strategy.entry || !strategy.exit) {
      throw new Error('模型返回的策略缺少必要字段');
    }

    return {
      generationId: id,
      strategy,
      summary: `基于 OpenAI ${this.model} 生成的策略`,
      warnings: [
        'AI 生成策略仅供参考，请在信号预览中验证。',
      ],
      requiresConfirmation: true,
    };
  }

  async refine(request: RefineStrategyRequest): Promise<GenerateStrategyResult> {
    const id = crypto.randomUUID();

    const response = await this.client.responses.create({
      model: this.model,
      input: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: `当前策略 DSL:\n${JSON.stringify(request.currentStrategy, null, 2)}\n\n修改要求: ${request.modification}\n\n只返回修改后的完整策略 JSON。`,
        },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'strategy_dsl',
          schema: getStrategyJsonSchema(),
          strict: true,
        },
      },
    });

    return {
      generationId: id,
      strategy: JSON.parse(response.output_text),
      summary: `已根据 "${request.modification}" 调整策略。`,
      warnings: [],
      requiresConfirmation: true,
    };
  }

  async explain(request: ExplainStrategyRequest): Promise<StrategyExplanation> {
    const response = await this.client.responses.create({
      model: this.model,
      input: [
        {
          role: 'user',
          content: `请用中文解释以下量化策略的风险和参数含义:\n\n${JSON.stringify(request.strategy, null, 2)}`,
        },
      ],
    });

    return {
      explanation: response.output_text,
      risks: [],
      parameterNotes: '',
    };
  }
}

function getStrategyJsonSchema(): Record<string, unknown> {
  // This is a simplified JSON Schema for the strategy DSL.
  // In production, this would be generated from the Zod schema.
  return {
    type: 'object',
    properties: {
      schemaVersion: { type: 'string', const: '1.0' },
      id: { type: 'string' },
      name: { type: 'string' },
      description: { type: 'string' },
      strategyVersion: { type: 'integer' },
      parameters: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            label: { type: 'string' },
            type: { type: 'string', enum: ['number', 'boolean'] },
            defaultValue: {},
            min: { type: 'number' },
            max: { type: 'number' },
            step: { type: 'number' },
            description: { type: 'string' },
          },
          required: ['name', 'label', 'type', 'defaultValue'],
        },
      },
      indicators: { type: 'array', items: { type: 'object' } },
      entry: { type: 'object' },
      exit: { type: 'object' },
      risk: { type: 'array', items: { type: 'object' } },
      metadata: { type: 'object' },
    },
    required: ['schemaVersion', 'id', 'name', 'strategyVersion', 'entry', 'exit', 'metadata'],
  };
}
