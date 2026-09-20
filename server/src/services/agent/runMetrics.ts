import type { PublicAgentEvent } from './eventProtocol.js';
import { researchDataUsable } from './toolOutcome.js';

export interface ProviderTelemetry {
  model?: string;
  apiDurationMs?: number;
  usage?: { inputTokens: number; cachedInputTokens: number; outputTokens: number; reasoningOutputTokens?: number };
  usageScope?: 'provider_total' | 'message';
  messageId?: string;
}

type Phase = 'discovery' | 'data' | 'computation' | 'report' | 'other';
interface ToolSpan { start: number; end?: number; phase: Phase; failed: boolean; }
export interface RunMetrics {
  version: 1;
  elapsedMs: number;
  providerStartupMs: number | null;
  providerApiMs: number | null;
  firstValidDataMs: number | null;
  firstSuccessfulDataToolMs: number | null;
  toolCalls: number;
  failedToolCalls: number;
  unfinishedToolCalls: number;
  failureCategories: Record<string, number>;
  toolWallMs: number;
  unattributedMs: number;
  phases: Record<Phase, { calls: number; failed: number; toolMs: number }>;
  reportRenderMs: number;
  fundFlowReportFallbacks: number;
  models: string[];
  usage: ProviderTelemetry['usage'] | null;
  usageScope: 'provider_total' | 'observed_messages' | null;
  note: string;
}

function phaseOf(name = '', input = ''): Phase {
  if (['Task', 'Agent'].includes(name) && /report-designer|整理.*报告|报告.*整理/.test(input)) return 'report';
  if (/researchData\.mjs|agentMarketData\.mjs|duckdb/.test(input)) {
    return /\b(catalog|describe|schema|views|doctor|coverage|help|recipes|status)\b/.test(input) ? 'discovery' : 'data';
  }
  if (/python|\.sql\b|backtest|factor/i.test(input)) return 'computation';
  return 'other';
}

export class AgentRunMetrics {
  private readonly began: number;
  private spans = new Map<string, ToolSpan>();
  private startup: number | null = null;
  private apiDuration: number | null = null;
  private firstData: number | null = null;
  private firstSuccess: number | null = null;
  private failures: Record<string, number> = {};
  private models = new Set<string>();
  private totalUsage: ProviderTelemetry['usage'];
  private messages = new Map<string, NonNullable<ProviderTelemetry['usage']>>();
  reportRenderMs = 0;
  fundFlowReportFallbacks = 0;

  constructor(private readonly clock = Date.now) { this.began = clock(); }
  providerStarted(): void { this.startup = this.clock() - this.began; }

  telemetry(value: ProviderTelemetry): void {
    if (value.model && /^[\w./:-]{1,120}$/.test(value.model)) this.models.add(value.model);
    if (value.apiDurationMs != null && Number.isFinite(value.apiDurationMs) && value.apiDurationMs >= 0) this.apiDuration = value.apiDurationMs;
    if (value.usage && Object.values(value.usage).every(v => Number.isFinite(v) && v >= 0)) {
      if (value.usageScope === 'provider_total') this.totalUsage = value.usage;
      else if (value.messageId) this.messages.set(value.messageId, value.usage);
    }
  }

  observe(event: PublicAgentEvent): void {
    const id = event.toolUseId;
    if (!id) return;
    if (event.type === 'tool_started') {
      const phase = phaseOf(event.toolName, event.toolInput);
      const span = this.spans.get(id);
      if (!span) this.spans.set(id, { start: this.clock(), phase, failed: false });
      else if (span.end == null && event.toolInput && event.toolInput !== '{}') span.phase = phase;
      return;
    }
    if (!['tool_finished', 'error'].includes(event.type)) return;
    const span = this.spans.get(id);
    if (!span || span.end != null) return;
    span.end = this.clock();
    span.failed = event.type === 'error';
    if (span.failed) {
      const category = event.toolFailure?.category ?? 'execution_error';
      this.failures[category] = (this.failures[category] ?? 0) + 1;
    } else if (span.phase === 'data') {
      this.firstSuccess ??= span.end - this.began;
      // Only an explicit validated data envelope proves useful data; exit 0 alone does not.
      if ((event.toolDataUsable ?? researchDataUsable(event.toolResult)) === true) this.firstData ??= span.end - this.began;
    }
  }

  snapshot(): RunMetrics {
    const now = this.clock();
    const phases = Object.fromEntries(['discovery', 'data', 'computation', 'report', 'other']
      .map(p => [p, { calls: 0, failed: 0, toolMs: 0 }])) as RunMetrics['phases'];
    const intervals: Array<[number, number]> = [];
    let failed = 0; let unfinished = 0;
    for (const span of this.spans.values()) {
      const end = span.end ?? now;
      phases[span.phase].calls++;
      phases[span.phase].toolMs += Math.max(0, end - span.start);
      if (span.failed) { failed++; phases[span.phase].failed++; }
      if (span.end == null) unfinished++;
      intervals.push([span.start, end]);
    }
    let toolWallMs = 0; let lastEnd = this.began;
    for (const [start, end] of intervals.sort((a, b) => a[0] - b[0])) {
      toolWallMs += Math.max(0, end - Math.max(start, lastEnd)); lastEnd = Math.max(lastEnd, end);
    }
    const usage = this.totalUsage ?? (this.messages.size ? [...this.messages.values()].reduce((a, b) => ({
      inputTokens: a.inputTokens + b.inputTokens, cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
      outputTokens: a.outputTokens + b.outputTokens,
      reasoningOutputTokens: (a.reasoningOutputTokens ?? 0) + (b.reasoningOutputTokens ?? 0),
    }), { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 }) : null);
    return {
      version: 1, elapsedMs: now - this.began, providerStartupMs: this.startup, providerApiMs: this.apiDuration,
      firstValidDataMs: this.firstData, firstSuccessfulDataToolMs: this.firstSuccess,
      toolCalls: this.spans.size, failedToolCalls: failed, unfinishedToolCalls: unfinished,
      failureCategories: { ...this.failures }, toolWallMs,
      unattributedMs: Math.max(0, now - this.began - toolWallMs - this.reportRenderMs), phases,
      reportRenderMs: this.reportRenderMs, fundFlowReportFallbacks: this.fundFlowReportFallbacks, models: [...this.models], usage,
      usageScope: this.totalUsage ? 'provider_total' : usage ? 'observed_messages' : null,
      note: '阶段按工具参数归类；并行工具时长不可相加。unattributedMs包含模型生成、请求等待和编排开销，不代表纯思考；未识别的有效取数及用量保持null。',
    };
  }
}

/** Allowlisted usage metadata only; never forward reasoning, content, credentials, or arbitrary provider fields. */
export function claudeTelemetry(line: string): ProviderTelemetry | undefined {
  let row: any;
  try { row = JSON.parse(line); } catch { return undefined; }
  const message = row.type === 'assistant' ? row.message : row.type === 'result' ? row : null;
  if (!message) return undefined;
  const usage = message.usage;
  return {
    model: message.model,
    messageId: message.id,
    usageScope: row.type === 'result' ? 'provider_total' : 'message',
    ...(row.type === 'result' && typeof row.duration_api_ms === 'number' ? { apiDurationMs: row.duration_api_ms } : {}),
    ...(usage ? { usage: {
      inputTokens: Number(usage.input_tokens ?? 0) + Number(usage.cache_creation_input_tokens ?? 0) + Number(usage.cache_read_input_tokens ?? 0),
      cachedInputTokens: Number(usage.cache_read_input_tokens ?? 0), outputTokens: Number(usage.output_tokens ?? 0),
    } } : {}),
  };
}
