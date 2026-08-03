import { apiFetch } from '@/api/client';
import type { AgentRun, AgentReport, AgentEvent } from './types';

export async function createAgentRun(prompt: string, maxTurns?: number, timeoutMinutes?: number): Promise<{ runId: string; status: string }> {
  return apiFetch<{ runId: string; status: string }>('/api/agent/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, maxTurns, timeoutMinutes }),
  });
}

export async function cancelAgentRun(runId: string): Promise<void> {
  await apiFetch(`/api/agent/runs/${runId}/cancel`, { method: 'POST' });
}

export async function listAgentRuns(limit?: number, offset?: number, status?: string): Promise<{ runs: AgentRun[] }> {
  const params = new URLSearchParams();
  if (limit) params.set('limit', String(limit));
  if (offset) params.set('offset', String(offset));
  if (status) params.set('status', status);
  return apiFetch<{ runs: AgentRun[] }>(`/api/agent/runs?${params}`);
}

export async function getAgentRun(runId: string): Promise<{ run: AgentRun; events: AgentEvent[]; report: AgentReport | null }> {
  return apiFetch<{ run: AgentRun; events: AgentEvent[]; report: AgentReport | null }>(`/api/agent/runs/${runId}`);
}

export function getReportHtmlUrl(runId: string): string {
  return `/api/agent/reports/${runId}/html`;
}

export function getReportDownloadUrl(runId: string): string {
  return `/api/agent/reports/${runId}/download`;
}

export async function listAgentReports(limit?: number, offset?: number): Promise<{ reports: AgentReport[] }> {
  const params = new URLSearchParams();
  if (limit) params.set('limit', String(limit));
  if (offset) params.set('offset', String(offset));
  return apiFetch<{ reports: AgentReport[] }>(`/api/agent/reports?${params}`);
}
