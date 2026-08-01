import { apiFetch } from '@/api/client';
import type {
  CreateMultiAssetPlanInput,
  StoredMultiAssetPlan,
  StoredMultiAssetRun,
} from './types';

export function listMultiAssetPlans(limit = 100) {
  return apiFetch<StoredMultiAssetPlan[]>(`/api/multi-asset/plans?limit=${limit}`);
}

export function getMultiAssetPlan(id: string) {
  return apiFetch<StoredMultiAssetPlan>(`/api/multi-asset/plans/${encodeURIComponent(id)}`);
}

export function createMultiAssetPlan(input: CreateMultiAssetPlanInput) {
  return apiFetch<{ plan: StoredMultiAssetPlan; reused: boolean }>('/api/multi-asset/plans', {
    method: 'POST', body: JSON.stringify(input), timeoutMs: 120_000,
  });
}

export function listMultiAssetRuns(planVersionId?: string, limit = 100) {
  const query = new URLSearchParams({ limit: String(limit) });
  if (planVersionId) query.set('planVersionId', planVersionId);
  return apiFetch<StoredMultiAssetRun[]>(`/api/multi-asset/runs?${query}`);
}

export function getMultiAssetRun(id: string) {
  return apiFetch<StoredMultiAssetRun>(`/api/multi-asset/runs/${encodeURIComponent(id)}`);
}

export function startMultiAssetRun(planVersionId: string, initialCash: number) {
  return apiFetch<{ run: StoredMultiAssetRun; reused: boolean }>(
    `/api/multi-asset/plans/${encodeURIComponent(planVersionId)}/runs`,
    {
      method: 'POST',
      body: JSON.stringify({
        initialCash,
        idempotencyKey: `multi-asset-ui:${planVersionId}:${crypto.randomUUID()}`,
      }),
    },
  );
}
