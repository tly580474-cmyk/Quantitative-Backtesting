import type {
  AIStatus,
  GenerateStrategyRequest,
  GenerateStrategyResult,
  RefineStrategyRequest,
  ExplainStrategyRequest,
  StrategyExplanation,
} from './types';

const BASE_URL = 'http://localhost:3001';

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message || body.error || `HTTP ${res.status}`);
  }

  return res.json();
}

export async function getAIStatus(): Promise<AIStatus> {
  return fetchJson<AIStatus>(`${BASE_URL}/api/ai/status`);
}

export async function generateStrategy(
  request: GenerateStrategyRequest,
): Promise<GenerateStrategyResult> {
  return fetchJson<GenerateStrategyResult>(
    `${BASE_URL}/api/ai/strategies/generate`,
    { method: 'POST', body: JSON.stringify(request) },
  );
}

export async function refineStrategy(
  request: RefineStrategyRequest,
): Promise<GenerateStrategyResult> {
  return fetchJson<GenerateStrategyResult>(
    `${BASE_URL}/api/ai/strategies/refine`,
    { method: 'POST', body: JSON.stringify(request) },
  );
}

export async function explainStrategy(
  request: ExplainStrategyRequest,
): Promise<StrategyExplanation> {
  return fetchJson<StrategyExplanation>(
    `${BASE_URL}/api/ai/strategies/explain`,
    { method: 'POST', body: JSON.stringify(request) },
  );
}
