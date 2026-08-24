import { ApiError, apiFetch } from '@/api/client';
import type {
  AgentRun, AgentReport, AgentEvent, AgentConversationTurn, AgentEventType,
  AgentAttachment, AgentAttachmentConfig, AgentProviderHealth, AgentProviderId,
} from './types';

interface AgentEventRecord {
  runId?: string;
  type?: AgentEventType;
  eventType?: string;
  publicContent?: string;
  content?: string;
  toolName?: string | null;
  toolUseId?: string | null;
  durationMs?: number | null;
  terminal?: AgentEvent['terminal'];
  seq?: number;
  timestamp?: string;
  createdAt?: string;
  approval?: AgentEvent['approval'];
}

const LEGACY_TYPES: Record<string, AgentEventType | undefined> = {
  text: 'assistant_text', tool_use: 'tool_started', tool_result: 'tool_finished',
  error: 'error', thought: undefined, done: undefined,
};

export function normalizeAgentEvent(event: AgentEventRecord): AgentEvent | null {
  const type = event.type ?? LEGACY_TYPES[event.eventType ?? ''];
  if (!type) return null;
  return {
    type,
    content: event.publicContent ?? event.content ?? '',
    runId: event.runId,
    toolName: event.toolName ?? undefined,
    toolUseId: event.toolUseId ?? undefined,
    durationMs: event.durationMs ?? undefined,
    terminal: event.terminal,
    seq: event.seq,
    timestamp: event.timestamp ?? event.createdAt,
    approval: event.approval,
  };
}

export async function createAgentRun(
  prompt: string, provider?: AgentProviderId, attachmentIds: string[] = [],
): Promise<{ runId: string; conversationId: string; status: string }> {
  return apiFetch('/api/agent/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, provider, attachmentIds }) });
}

export async function cancelAgentRun(runId: string): Promise<void> {
  await apiFetch(`/api/agent/runs/${runId}/cancel`, { method: 'POST' });
}
export async function deleteAgentRun(runId: string): Promise<void> {
  await apiFetch(`/api/agent/runs/${runId}`, { method: 'DELETE' });
}
export async function deleteAgentConversation(conversationId: string): Promise<void> {
  await apiFetch(`/api/agent/conversations/${conversationId}`, { method: 'DELETE' });
}
export async function retryAgentRun(runId: string): Promise<{
  runId: string; conversationId: string; status: string; parentRunId: string; prompt: string;
}> {
  return apiFetch(`/api/agent/runs/${runId}/retry`, { method: 'POST' });
}
export async function continueAgentRun(
  parentRunId: string, prompt: string, attachmentIds: string[] = [],
): Promise<{ runId: string; conversationId: string; status: string; parentRunId: string }> {
  return apiFetch(`/api/agent/runs/${parentRunId}/continue`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, attachmentIds }) });
}

export async function uploadAgentAttachment(file: File): Promise<AgentAttachment> {
  const form = new FormData();
  form.append('file', file, file.name);
  const result = await apiFetch<{ attachment: AgentAttachment }>('/api/agent/attachments', {
    method: 'POST', body: form, timeoutMs: 120_000,
  });
  return result.attachment;
}

export async function deleteAgentAttachment(attachmentId: string): Promise<void> {
  await apiFetch(`/api/agent/attachments/${attachmentId}`, { method: 'DELETE' });
}

export async function decideAgentApproval(approvalId: string, decision: 'approved' | 'denied'): Promise<void> {
  await apiFetch(`/api/agent/approvals/${approvalId}/decision`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision }),
  });
}

export async function getAgentProviders(): Promise<{
  defaultProvider: AgentProviderId;
  providers: AgentProviderHealth[];
  attachments: AgentAttachmentConfig;
}> {
  return apiFetch('/api/agent/providers');
}

export async function listAgentConversations(limit = 30, cursor?: string) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor) params.set('cursor', cursor);
  return apiFetch<{ conversations: AgentRun[]; nextCursor: string | null }>(`/api/agent/conversations?${params}`);
}

export async function listAgentRuns(limit?: number, offset?: number, status?: string): Promise<{ runs: AgentRun[] }> {
  const params = new URLSearchParams();
  if (limit) params.set('limit', String(limit));
  if (offset) params.set('offset', String(offset));
  if (status) params.set('status', status);
  return apiFetch(`/api/agent/runs?${params}`);
}

export async function getAgentRun(runId: string): Promise<{
  run: AgentRun; events: AgentEvent[]; report: AgentReport | null; attachments: AgentAttachment[];
}> {
  const result = await apiFetch<{
    run: AgentRun; events: AgentEventRecord[]; report: AgentReport | null; attachments: AgentAttachment[];
  }>(`/api/agent/runs/${runId}`);
  return { ...result, events: result.events.map(normalizeAgentEvent).filter((event): event is AgentEvent => Boolean(event)) };
}

export async function getAgentConversation(identifier: string): Promise<{ turns: AgentConversationTurn[] }> {
  try {
    const all: AgentConversationTurn[] = [];
    let cursor: string | undefined;
    do {
      const params = new URLSearchParams({ limit: '20' });
      if (cursor) params.set('cursor', cursor);
      const page = await apiFetch<{ turns: Array<{ run: AgentRun; events: AgentEventRecord[]; report: AgentReport | null }>; nextCursor: number | null }>(
        `/api/agent/conversations/${identifier}/turns?${params}`,
      );
      all.unshift(...page.turns.map(turn => ({ ...turn,
        events: turn.events.map(normalizeAgentEvent).filter((event): event is AgentEvent => Boolean(event)) })));
      cursor = page.nextCursor == null ? undefined : String(page.nextCursor);
    } while (cursor && all.length < 200);
    if (all.length) return { turns: all };
    throw new ApiError('NOT_FOUND', 'Conversation not found', 404);
  } catch (error) {
    if (!(error instanceof ApiError) || error.statusCode !== 404) throw error;
    const result = await apiFetch<{ turns: Array<{ run: AgentRun; events: AgentEventRecord[]; report: AgentReport | null }> }>(
      `/api/agent/runs/${identifier}/conversation`,
    );
    return { turns: result.turns.map(turn => ({ ...turn,
      events: turn.events.map(normalizeAgentEvent).filter((event): event is AgentEvent => Boolean(event)) })) };
  }
}

export const getReportHtmlUrl = (runId: string) => `/api/agent/reports/${runId}/html`;
export const getReportDownloadUrl = (runId: string) => `/api/agent/reports/${runId}/download`;
export async function getAgentReport(runId: string): Promise<AgentReport> {
  return apiFetch(`/api/agent/reports/${runId}`);
}
export async function listAgentReports(limit?: number, offset?: number): Promise<{ reports: AgentReport[] }> {
  const params = new URLSearchParams();
  if (limit) params.set('limit', String(limit));
  if (offset) params.set('offset', String(offset));
  return apiFetch(`/api/agent/reports?${params}`);
}
