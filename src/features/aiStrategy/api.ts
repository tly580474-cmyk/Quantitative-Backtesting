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
