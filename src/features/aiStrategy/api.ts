import type {
  AIStatus,
  GenerateStrategyRequest,
  GenerateStrategyResult,
  RefineStrategyRequest,
  ExplainStrategyRequest,
  StrategyExplanation,
} from './types';
import { API_BASE_URL } from '@/api/config';

export class AIServiceError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AIServiceError';
  }
}

const ERROR_MESSAGES: Record<string, string> = {
  INVALID_MODEL_OUTPUT: '模型输出未通过策略结构校验，请检查下方字段提示后修改原始描述并重新生成。',
  INVALID_PROMPT: '策略描述为空或格式无效，请补充明确的买入、卖出和风控条件。',
  PROMPT_TOO_LONG: '策略描述超过长度限制，请精简后重新提交。',
  INVALID_MODEL: '所选模型当前不可用，请切换到服务端允许的模型。',
  AI_NOT_ENABLED: 'AI 策略服务当前未启用。',
  GENERATION_FAILED: '策略生成服务运行失败，请稍后使用相同描述重试。',
};

function readableValidationDetail(value: unknown): string {
  if (typeof value !== 'string') return String(value);
  const [path, ...message] = value.split(':');
  const labels: Record<string, string> = {
    entry: '买入条件',
    exit: '卖出条件',
    indicators: '技术指标',
    parameters: '策略参数',
    risk: '风控规则',
    metadata: '系统元数据',
  };
  const root = path.split('.')[0];
  return `${labels[root] ?? path}：${message.join(':').trim() || '字段格式不正确'}`;
}

export function toAIUserMessage(error: unknown): string {
  if (!(error instanceof AIServiceError)) {
    return error instanceof Error ? error.message : '策略生成失败';
  }
  const summary = (error.code && ERROR_MESSAGES[error.code]) || error.message;
  if (!Array.isArray(error.details) || error.details.length === 0) return summary;
  return `${summary}\n${error.details.map(readableValidationDetail).join('\n')}`;
}

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new AIServiceError(
      body.message || body.error || `HTTP ${res.status}`,
      res.status,
      body.error,
      body.details,
    );
  }

  return res.json();
}

export async function getAIStatus(signal?: AbortSignal): Promise<AIStatus> {
  return fetchJson<AIStatus>(`${API_BASE_URL}/api/ai/status`, { signal });
}

export async function generateStrategy(
  request: GenerateStrategyRequest,
  signal?: AbortSignal,
): Promise<GenerateStrategyResult> {
  return fetchJson<GenerateStrategyResult>(
    `${API_BASE_URL}/api/ai/strategies/generate`,
    { method: 'POST', body: JSON.stringify(request), signal },
  );
}

export async function refineStrategy(
  request: RefineStrategyRequest,
  signal?: AbortSignal,
): Promise<GenerateStrategyResult> {
  return fetchJson<GenerateStrategyResult>(
    `${API_BASE_URL}/api/ai/strategies/refine`,
    { method: 'POST', body: JSON.stringify(request), signal },
  );
}

export async function explainStrategy(
  request: ExplainStrategyRequest,
  signal?: AbortSignal,
): Promise<StrategyExplanation> {
  return fetchJson<StrategyExplanation>(
    `${API_BASE_URL}/api/ai/strategies/explain`,
    { method: 'POST', body: JSON.stringify(request), signal },
  );
}
