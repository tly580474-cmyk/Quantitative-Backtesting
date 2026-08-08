export interface AgentEvent {
  type: 'thought' | 'tool_use' | 'tool_result' | 'text' | 'error' | 'done' | 'user';
  content: string;
  toolName?: string;
  toolInput?: string;
  toolResult?: string;
  seq?: number;
  timestamp?: string;
}

export interface AgentRun {
  id: string;
  prompt: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'canceled';
  maxTurns: number;
  timeoutMs: number;
  pid: number | null;
  sessionId: string | null;
  parentRunId: string | null;
  exitCode: number | null;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface AgentReport {
  id: number;
  runId: string;
  title: string;
  htmlPath: string;
  fileSize: number | null;
  summary: string | null;
  chartsCount: number;
  createdAt: string;
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
}
