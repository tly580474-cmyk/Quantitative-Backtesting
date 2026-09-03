import type {
  AIStatus,
  GenerateStrategyRequest,
  GenerateStrategyResult,
  RefineStrategyRequest,
  ExplainStrategyRequest,
  StrategyExplanation,
} from './types';
import { API_BASE_URL } from '@/api/config';
import { apiFetchNdjson } from '@/api/client';

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
  onReasoningDelta?: (content: string) => void,
): Promise<GenerateStrategyResult> {
  if (onReasoningDelta) return fetchStrategyStream('/api/ai/strategies/generate', request, signal, onReasoningDelta);
  return fetchJson<GenerateStrategyResult>(
    `${API_BASE_URL}/api/ai/strategies/generate`,
    { method: 'POST', body: JSON.stringify(request), signal },
  );
}

export async function refineStrategy(
  request: RefineStrategyRequest,
  signal?: AbortSignal,
  onReasoningDelta?: (content: string) => void,
): Promise<GenerateStrategyResult> {
  if (onReasoningDelta) return fetchStrategyStream('/api/ai/strategies/refine', request, signal, onReasoningDelta);
  return fetchJson<GenerateStrategyResult>(
    `${API_BASE_URL}/api/ai/strategies/refine`,
    { method: 'POST', body: JSON.stringify(request), signal },
  );
}

async function fetchStrategyStream(
  path: string,
  request: GenerateStrategyRequest | RefineStrategyRequest,
  signal: AbortSignal | undefined,
  onReasoningDelta: (content: string) => void,
): Promise<GenerateStrategyResult> {
  type Event =
    | { type: 'start' }
    | { type: 'reasoning_delta'; content: string }
    | { type: 'done'; result: GenerateStrategyResult }
    | { type: 'error'; message: string; details?: unknown };
  let result: GenerateStrategyResult | null = null;
  await apiFetchNdjson<Event>(path, {
    method: 'POST',
    body: JSON.stringify(request),
    signal,
    timeoutMs: 180000,
  }, (event) => {
    if (event.type === 'reasoning_delta') onReasoningDelta(event.content);
    else if (event.type === 'done') result = event.result;
    else if (event.type === 'error') throw new AIServiceError(event.message, 422, 'INVALID_MODEL_OUTPUT', event.details);
  });
  const completed = result as GenerateStrategyResult | null;
  if (!completed) throw new AIServiceError('策略生成流未完整返回', 502, 'INCOMPLETE_STREAM');
  return completed;
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
