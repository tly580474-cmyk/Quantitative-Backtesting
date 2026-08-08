import { ApiError, apiFetch } from '@/api/client';
import type { AgentRun, AgentReport, AgentEvent, AgentConversationTurn } from './types';

interface AgentEventRecord {
  type?: AgentEvent['type'];
  eventType?: AgentEvent['type'];
  content: string;
  toolName?: string | null;
  toolInput?: string | null;
  toolResult?: string | null;
  seq?: number;
  timestamp?: string;
  createdAt?: string;
}

function normalizeAgentEvent(event: AgentEventRecord): AgentEvent {
  return {
    type: event.type ?? event.eventType ?? 'text',
    content: event.content,
    toolName: event.toolName ?? undefined,
    toolInput: event.toolInput ?? undefined,
    toolResult: event.toolResult ?? undefined,
    seq: event.seq,
    timestamp: event.timestamp ?? event.createdAt,
  };
}

export async function createAgentRun(
  prompt: string,
  maxTurns?: number,
  timeoutMinutes?: number,
  templateStyle?: string,
): Promise<{ runId: string; status: string }> {
  return apiFetch<{ runId: string; status: string }>('/api/agent/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, maxTurns, timeoutMinutes, templateStyle }),
  });
}

export async function cancelAgentRun(runId: string): Promise<void> {
  await apiFetch(`/api/agent/runs/${runId}/cancel`, { method: 'POST' });
}

export async function deleteAgentRun(runId: string): Promise<void> {
  await apiFetch(`/api/agent/runs/${runId}`, { method: 'DELETE' });
}

export async function continueAgentRun(
  parentRunId: string,
  prompt: string,
  maxTurns?: number,
  timeoutMinutes?: number,
  templateStyle?: string,
): Promise<{ runId: string; status: string; parentRunId: string }> {
  return apiFetch<{ runId: string; status: string; parentRunId: string }>(`/api/agent/runs/${parentRunId}/continue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, maxTurns, timeoutMinutes, templateStyle }),
  });
}

export async function listAgentRuns(limit?: number, offset?: number, status?: string): Promise<{ runs: AgentRun[] }> {
  const params = new URLSearchParams();
  if (limit) params.set('limit', String(limit));
  if (offset) params.set('offset', String(offset));
  if (status) params.set('status', status);
  return apiFetch<{ runs: AgentRun[] }>(`/api/agent/runs?${params}`);
}

export async function getAgentRun(runId: string): Promise<{ run: AgentRun; events: AgentEvent[]; report: AgentReport | null }> {
  const result = await apiFetch<{ run: AgentRun; events: AgentEventRecord[]; report: AgentReport | null }>(`/api/agent/runs/${runId}`);
  return { ...result, events: result.events.map(normalizeAgentEvent) };
}

export async function getAgentConversation(runId: string): Promise<{ turns: AgentConversationTurn[] }> {
  try {
    const result = await apiFetch<{ turns: Array<Omit<AgentConversationTurn, 'events'> & { events: AgentEventRecord[] }> }>(
      `/api/agent/runs/${runId}/conversation`,
    );
    return {
      turns: result.turns.map(turn => ({
        ...turn,
        events: turn.events.map(normalizeAgentEvent),
      })),
    };
  } catch (error) {
    // Compatibility with an already-running older server: rebuild the chain
    // from the established run-detail endpoint until the server is restarted.
    if (!(error instanceof ApiError) || error.statusCode !== 404) throw error;

    const turns: AgentConversationTurn[] = [];
    const visited = new Set<string>();
    let currentId: string | null = runId;
    while (currentId && !visited.has(currentId) && turns.length < 200) {
      visited.add(currentId);
      const detail = await getAgentRun(currentId);
      turns.push(detail);
      currentId = detail.run.parentRunId;
    }
    return { turns: turns.reverse() };
  }
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
