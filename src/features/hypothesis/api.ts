import { apiFetch } from '@/api/client';
import type {
  Hypothesis,
  HypothesisEvaluationRequest,
  HypothesisStatus,
} from './types';

export interface GenerateHypothesesResult {
  hypotheses: Hypothesis[];
  rejected: Array<{ name: string; reason: string }>;
}

export interface HypothesisOutcome {
  hypothesis: Hypothesis;
  experimentVersionId: string;
  runId: string;
  validationStatus: string | null;
  evaluationSummary: Hypothesis['evaluationSummary'];
}

export async function generateHypotheses(input: {
  prompt?: string;
  count?: number;
  model?: string;
}): Promise<GenerateHypothesesResult> {
  return apiFetch<GenerateHypothesesResult>('/api/hypotheses/generate', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function listHypotheses(limit = 100): Promise<Hypothesis[]> {
  const result = await apiFetch<{ hypotheses: Hypothesis[] }>(
    `/api/hypotheses?limit=${limit}`,
  );
  return result.hypotheses;
}

export async function evaluateHypothesis(
  id: string,
  input: HypothesisEvaluationRequest,
): Promise<HypothesisOutcome> {
  return apiFetch<{ outcome: HypothesisOutcome }>(`/api/hypotheses/${id}/evaluate`, {
    method: 'POST',
    body: JSON.stringify(input),
    timeoutMs: 120_000,
  }).then((result) => result.outcome);
}

export async function rejectHypothesis(
  id: string,
  reason: string,
): Promise<Hypothesis> {
  const result = await apiFetch<{ hypothesis: Hypothesis }>(`/api/hypotheses/${id}/reject`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
  return result.hypothesis;
}

export function hypothesisStatusLabel(status: HypothesisStatus): string {
  return { draft: '草稿', evaluated: '已评估', rejected: '已拒绝' }[status];
}

export function hypothesisStatusColor(status: HypothesisStatus): string {
  return { draft: 'default', evaluated: 'success', rejected: 'error' }[status];
}
