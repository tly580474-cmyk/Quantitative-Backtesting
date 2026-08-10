export type AgentEventType =
  | 'progress' | 'tool_started' | 'tool_finished' | 'assistant_text' | 'assistant_final'
  | 'confirmation_required' | 'error' | 'terminal' | 'user';

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
}

export interface AgentRun {
  id: string;
  prompt: string;
  status: 'pending' | 'starting' | 'running' | 'completed' | 'failed' | 'canceled';
  maxTurns: number;
  timeoutMs: number;
  pid: number | null;
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

export interface AgentConversationTurn { run: AgentRun; events: AgentEvent[]; report: AgentReport | null; }
