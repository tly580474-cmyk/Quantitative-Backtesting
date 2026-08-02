import { apiFetch } from '@/api/client';
import { API_BASE_URL } from '@/api/config';
import type {
  CreateMultiAssetPlanInput,
  StoredMultiAssetPlan,
  StoredMultiAssetRun,
  MultiAssetRunArtifact,
} from './types';

export function listMultiAssetPlans(limit = 100) {
  return apiFetch<StoredMultiAssetPlan[]>(`/api/multi-asset/plans?limit=${limit}`);
}

export function cancelMultiAssetRun(id: string) {
  return apiFetch<StoredMultiAssetRun>(`/api/multi-asset/runs/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
}

export function retryMultiAssetRun(id: string) {
  return apiFetch<StoredMultiAssetRun>(`/api/multi-asset/runs/${encodeURIComponent(id)}/retry`, { method: 'POST' });
}

export function listMultiAssetRunArtifacts(id: string) {
  return apiFetch<MultiAssetRunArtifact[]>(`/api/multi-asset/runs/${encodeURIComponent(id)}/artifacts`);
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

export async function downloadMultiAssetArtifact(id: string) {
  const response = await fetch(
    `${API_BASE_URL}/api/multi-asset/artifacts/${encodeURIComponent(id)}/download`,
  );
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      const body = await response.json() as { message?: string };
      if (body.message) message = body.message;
    } catch {
      // The download endpoint may return a non-JSON error response.
    }
    throw new Error(message);
  }

  const disposition = response.headers.get('content-disposition') ?? '';
  const encodedName = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const quotedName = disposition.match(/filename="([^"]+)"/i)?.[1];
  const filename = encodedName
    ? decodeURIComponent(encodedName)
    : quotedName ?? `multi-asset-artifact-${id}.json`;

  return { blob: await response.blob(), filename };
}
