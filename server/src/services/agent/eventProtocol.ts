export const PUBLIC_EVENT_TYPES = [
  'progress',
  'tool_started',
  'tool_finished',
  'assistant_text',
  'assistant_final',
  'confirmation_required',
  'error',
  'terminal',
] as const;

export type PublicAgentEventType = typeof PUBLIC_EVENT_TYPES[number];
export type TerminalStatus = 'completed' | 'failed' | 'canceled';

export interface TerminalPayload {
  status: TerminalStatus;
  exitCode: number | null;
  errorCode?: string;
}

export interface PublicAgentEvent {
  runId?: string;
  type: PublicAgentEventType;
  publicContent: string;
  timestamp: string;
  toolName?: string;
  toolUseId?: string;
  durationMs?: number;
  terminal?: TerminalPayload;
  sessionId?: string;
}

const MAX_PUBLIC_CONTENT = 12_000;
const SECRET_PATTERNS: RegExp[] = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}\b/g,
  /\b[A-Za-z0-9_-]*(?:token|secret|password|api[_-]?key)[A-Za-z0-9_-]*\s*[:=]\s*[^\s,;]+/gi,
  /\b(?:mysql|postgres(?:ql)?|mongodb|redis):\/\/[^\s'"<>]+/gi,
  /\b(?:authorization|proxy-authorization)\s*:\s*[^\r\n]+/gi,
  /(?:[A-Za-z]:\\|\/(?:home|Users|mnt)\/)[^\s'"<>]+/g,
];

export function sanitizePublicContent(value: unknown, fallback = ''): string {
  let text = typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value);
  text = text.replace(/\u0000/g, '').replace(/\r\n?/g, '\n');
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, '[已隐藏]');
  text = text.trim();
  if (!text) return fallback;
  return text.length > MAX_PUBLIC_CONTENT
    ? `${text.slice(0, MAX_PUBLIC_CONTENT)}\n…（内容已截断）`
    : text;
}

export function sanitizeToolName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 64);
  return normalized || undefined;
}

export function isTerminalStatus(status: string): status is TerminalStatus {
  return status === 'completed' || status === 'failed' || status === 'canceled';
}

export function isPublicAgentEventType(type: string): type is PublicAgentEventType {
  return (PUBLIC_EVENT_TYPES as readonly string[]).includes(type);
}
