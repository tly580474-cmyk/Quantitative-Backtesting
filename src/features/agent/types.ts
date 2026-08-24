export type AgentEventType =
  | 'progress' | 'tool_started' | 'tool_finished' | 'assistant_text' | 'assistant_final'
  | 'confirmation_required' | 'error' | 'terminal' | 'user';

export type AgentProviderId = 'claude' | 'codex';

export interface AgentProviderHealth {
  id: AgentProviderId;
  enabled: boolean;
  available: boolean;
  reason: string | null;
  capabilities: {
    streaming: boolean; resume: boolean; cancel: boolean; approvals: boolean;
    sandbox: boolean; skills: boolean; mcp: boolean;
  };
}

export interface AgentAttachment {
  id: string;
  name: string;
  mediaType: string;
  kind: 'image' | 'document' | 'text' | 'spreadsheet';
  size: number;
}

export interface AgentAttachmentConfig {
  maxFiles: number;
  maxFileMb: number;
  accept: string;
}

export interface AgentEvent {
  type: AgentEventType;
  content: string;
  runId?: string;
  toolName?: string;
  toolUseId?: string;
  durationMs?: number;
  terminal?: { status: 'completed' | 'failed' | 'canceled'; exitCode: number | null; errorCode?: string };
  seq?: number;
  timestamp?: string;
  approval?: {
    id: string; requestType: 'command' | 'file_change' | 'network' | 'permissions';
    status: 'pending' | 'approved' | 'denied' | 'expired' | 'canceled';
    expiresAt: string; summary: string;
  };
  attachments?: AgentAttachment[];
}

export interface AgentRun {
  id: string;
  prompt: string;
  status: 'pending' | 'starting' | 'running' | 'completed' | 'failed' | 'canceled';
  maxTurns: number;
  timeoutMs: number;
  pid: number | null;
  provider: AgentProviderId;
  providerRuntime: 'native' | 'legacy';
  sessionId: string | null;
  parentRunId: string | null;
  conversationId: string;
  turnIndex: number;
  protocolVersion: number;
  rootPrompt?: string;
  exitCode: number | null;
  errorMessage: string | null;
  errorCode: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface AgentReport {
  id: number; runId: string; title: string; htmlPath: string; fileSize: number | null;
  summary: string | null; chartsCount: number; createdAt: string;
}

export interface AgentStreamState {
  events: AgentEvent[];
  status: 'idle' | 'connecting' | 'running' | 'completed' | 'failed' | 'canceled';
  reportUrl: string | null;
  reportMeta: { title: string; summary: string } | null;
}

export interface AgentConversationTurn {
  run: AgentRun;
  events: AgentEvent[];
  report: AgentReport | null;
  attachments?: AgentAttachment[];
}
