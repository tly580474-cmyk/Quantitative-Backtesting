import type { PublicAgentEvent } from '../eventProtocol.js';

export type AgentProviderId = 'claude' | 'codex';

export interface AgentProviderCapabilities {
  streaming: boolean;
  resume: boolean;
  cancel: boolean;
  approvals: boolean;
  sandbox: boolean;
  skills: boolean;
  mcp: boolean;
}

export interface AgentProviderHealth {
  id: AgentProviderId;
  enabled: boolean;
  available: boolean;
  reason: string | null;
  capabilities: AgentProviderCapabilities;
}

export interface ProviderStartParams {
  runId: string;
  prompt: string;
  maxTurns: number;
  resumeSessionId?: string;
}

export type ApprovalDecision = 'approved' | 'denied';

export interface ProviderApprovalRequest {
  threadId: string;
  turnId: string;
  itemId: string;
  requestType: 'command' | 'file_change' | 'network' | 'permissions';
  summary: string;
}

export interface ProviderEventSink {
  event(event: PublicAgentEvent): Promise<void>;
  session(sessionId: string): Promise<void>;
  reportDecision(generate: boolean): Promise<void>;
  approval?(request: ProviderApprovalRequest): Promise<ApprovalDecision>;
}

export interface ProviderCompletion {
  status: 'completed' | 'failed' | 'interrupted';
  exitCode: number | null;
  errorCode?: string;
  errorMessage?: string;
}

export interface ProviderRun {
  pid: number | null;
  threadId?: string;
  completion: Promise<ProviderCompletion>;
  cancel(): Promise<void>;
}

export interface AgentProvider {
  readonly id: AgentProviderId;
  readonly capabilities: AgentProviderCapabilities;
  start(params: ProviderStartParams, sink: ProviderEventSink): Promise<ProviderRun>;
  health(): AgentProviderHealth;
  shutdown(): Promise<void>;
}
