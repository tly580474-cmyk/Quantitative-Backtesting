import { apiFetch } from '@/api/client';

// N4.2 前端封装：中文解释 Agent（只解释与建议，不改策略 JSON）。

export interface ErrorInterpretationSuggestion {
  id: string;
  label: string;
  /** 点选后预填到 prompt 的修正文本 */
  promptPatch: string;
  appliesTo: string;
}

export interface ErrorInterpretation {
  category: string;
  explanation: string;
  suggestions: ErrorInterpretationSuggestion[];
  /** 是否为确定性兜底（LLM 不可用） */
  fallback: boolean;
}

export async function interpretError(input: {
  category: string;
  issues?: string[];
  fieldPaths?: string[];
  prompt?: string;
  capabilitySummary?: string;
}): Promise<ErrorInterpretation> {
  const result = await apiFetch<{ interpretation: ErrorInterpretation }>(
    '/api/ai/errors/interpret',
    { method: 'POST', body: JSON.stringify(input) },
  );
  return result.interpretation;
}
