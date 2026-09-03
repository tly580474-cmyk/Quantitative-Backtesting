import OpenAI from 'openai';

export interface FactorReportInterpretationConfig {
  apiKey: string;
  baseURL: string;
  model: string;
  timeoutMs: number;
}

export interface FactorReportInterpretationInput {
  run: {
    id: string;
    factorVersionId: string;
    snapshotId: string;
    dateStart: string;
    dateEnd: string;
    totalDates: number;
    completedDates: number;
  };
  report: unknown;
  daily: unknown[];
}

export interface FactorReportInterpretation {
  model: string;
  generatedAt: string;
  interpretation: string;
  reasoningContent?: string;
}

export interface FactorReportInterpretationStreamOptions {
  onDelta?: (content: string) => void;
  onReasoningDelta?: (content: string) => void;
}

export async function interpretFactorReport(
  config: FactorReportInterpretationConfig,
  input: FactorReportInterpretationInput,
  options: FactorReportInterpretationStreamOptions = {},
): Promise<FactorReportInterpretation> {
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    timeout: config.timeoutMs,
    maxRetries: 1,
  });
  const summary = buildCompactReportSummary(input);
  const requestBody = {
    model: config.model,
    messages: [
      {
        role: 'system',
        content: [
          '你是专业的量化研究报告解读智能体。',
          '你的任务是用中文解释因子研究报告，指出有效性、稳定性、风险和下一步研究建议。',
          '不要给出个股买卖建议，不要承诺收益。',
          '输出 Markdown，结构紧凑，适合直接显示在产品侧边栏。',
        ].join('\n'),
      },
      {
        role: 'user',
        content: `请解读以下因子研究报告摘要。\n\n${JSON.stringify(summary, null, 2)}`,
      },
    ],
    max_tokens: 1800,
    reasoning_effort: 'low',
    thinking: { type: 'enabled' as const },
  };
  let interpretation = '';
  let reasoningContent = '';
  if (options.onDelta || options.onReasoningDelta) {
    const stream = await client.chat.completions.create({
      ...requestBody,
      stream: true,
    } as Parameters<typeof client.chat.completions.create>[0] & { thinking?: unknown }) as AsyncIterable<FactorInterpretationStreamChunk>;
    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta;
      if (delta?.reasoning_content) {
        reasoningContent += delta.reasoning_content;
        options.onReasoningDelta?.(delta.reasoning_content);
      }
      if (delta?.content) {
        interpretation += delta.content;
        options.onDelta?.(delta.content);
      }
    }
  } else {
    const response = await client.chat.completions.create(
      requestBody as Parameters<typeof client.chat.completions.create>[0] & { thinking?: unknown },
    );
    const completion = response as unknown as {
      choices: Array<{ message?: { content?: string | null; reasoning_content?: string | null } }>;
    };
    const message = completion.choices[0]?.message;
    interpretation = message?.content ?? '';
    reasoningContent = message?.reasoning_content ?? '';
  }
  interpretation = interpretation.trim();
  reasoningContent = reasoningContent.trim();
  if (!interpretation) throw new Error('模型返回了空解读');
  return {
    model: config.model,
    generatedAt: new Date().toISOString(),
    interpretation,
    reasoningContent,
  };
}

type FactorInterpretationStreamChunk = {
  choices?: Array<{ delta?: { content?: string | null; reasoning_content?: string | null } }>;
};

function buildCompactReportSummary(input: FactorReportInterpretationInput) {
  const report = asRecord(input.report);
  const summary = asRecord(report.summary);
  const config = asRecord(report.config);
  const layers = Array.isArray(report.layers) ? report.layers : [];
  const weights = Array.isArray(report.weights) ? report.weights : [];
  const correlations = Array.isArray(report.correlations) ? report.correlations : [];
  const sampleSplit = asRecord(report.sampleSplit);
  const factors = Array.isArray(report.factors)
    ? report.factors.map((item) => pick(asRecord(item), ['id', 'name', 'direction', 'description']))
    : report.factor ? [pick(asRecord(report.factor), ['id', 'name', 'direction', 'description'])] : [];
  return {
    run: input.run,
    kind: Array.isArray(report.factors) ? 'composite' : 'single',
    factors,
    config: pick(config, [
      'factorId',
      'factorIds',
      'startDate',
      'endDate',
      'validationStartDate',
      'horizonDays',
      'layers',
      'weighting',
      'markets',
      'symbols',
      'minDailyAmount',
    ]),
    summary,
    sampleSplit,
    layers: layers.slice(0, 20),
    weights: weights.slice(0, 20),
    correlations: correlations.slice(0, 80),
    dailyPreview: {
      first: input.daily.slice(0, 8),
      last: input.daily.slice(-8),
      count: input.daily.length,
    },
    guardrail: '仅用于量化研究复盘，不构成投资建议。',
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function pick(source: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys
    .filter((key) => source[key] !== undefined)
    .map((key) => [key, source[key]]));
}
