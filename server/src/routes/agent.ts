import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'mysql2/promise';
import { readFile, unlink } from 'fs/promises';
import { isAbsolute, relative, resolve } from 'path';
import { z } from 'zod';
import { ErrorCodes, apiError, dbUnavailable } from '../validation/errors.js';
import { AgentRepository, type AgentEventRecord, type AgentRunRecord } from '../services/agent/agentRepository.js';
import type { AgentOrchestrator } from '../services/agent/agentOrchestrator.js';
import { isPublicAgentEventType, sanitizePublicContent, type PublicAgentEvent } from '../services/agent/eventProtocol.js';
import type { EnvConfig } from '../config.js';
import type { AgentProviderId } from '../services/agent/providers/types.js';

const TERMINAL = new Set(['completed', 'failed', 'canceled']);

function isLoopback(request: FastifyRequest): boolean {
  const address = request.ip.replace(/^::ffff:/, '');
  return address === '127.0.0.1' || address === '::1';
}

export function isLoopbackOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  try {
    const hostname = new URL(origin).hostname.replace(/^\[|\]$/g, '');
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  } catch { return false; }
}

function publicEvent(record: AgentEventRecord, lastLegacyTextSeq = -1): (PublicAgentEvent & { seq: number }) | null {
  const timestamp = record.createdAt;
  if (record.protocolVersion >= 2 && isPublicAgentEventType(record.eventType)) {
    return {
      type: record.eventType,
      runId: record.runId,
      publicContent: record.content,
      timestamp,
      seq: record.seq,
      ...(record.toolName ? { toolName: record.toolName } : {}),
      ...(record.toolUseId ? { toolUseId: record.toolUseId } : {}),
      ...(record.durationMs != null ? { durationMs: record.durationMs } : {}),
      ...(record.terminal ? { terminal: record.terminal } : {}),
      ...(record.approval ? { approval: record.approval } : {}),
    };
  }
  // v1 compatibility adapter. Raw thoughts and raw tool payloads remain hidden.
  if (record.eventType === 'thought' || record.eventType === 'done') return null;
  const type = record.eventType === 'tool_use' ? 'tool_started'
    : record.eventType === 'tool_result' ? 'tool_finished'
    : record.eventType === 'error' ? 'error'
    : record.seq === lastLegacyTextSeq ? 'assistant_final' : 'progress';
  return {
    type, runId: record.runId, publicContent: type === 'tool_started' ? `正在使用 ${record.toolName ?? '工具'}`
      : type === 'tool_finished' ? '工具执行完成' : sanitizePublicContent(record.content),
    timestamp, seq: record.seq, ...(record.toolName ? { toolName: record.toolName } : {}),
  };
}

function publicEvents(records: AgentEventRecord[]): Array<PublicAgentEvent & { seq: number }> {
  const lastLegacyTextSeq = records.reduce(
    (last, record) => record.protocolVersion < 2 && record.eventType === 'text' ? Math.max(last, record.seq) : last, -1,
  );
  return records.map(record => publicEvent(record, lastLegacyTextSeq)).filter(
    (event): event is PublicAgentEvent & { seq: number } => Boolean(event),
  );
}

function eventsWithTerminal(run: AgentRunRecord, records: AgentEventRecord[]): Array<PublicAgentEvent & { seq: number }> {
  const events = publicEvents(records);
  if (TERMINAL.has(run.status) && !events.some(event => event.type === 'terminal')) {
    const lastSeq = events.reduce((max, event) => Math.max(max, event.seq), 0);
    events.push(synthesizedTerminal(run, lastSeq + 1));
  }
  return events;
}

function synthesizedTerminal(run: AgentRunRecord, seq: number): PublicAgentEvent & { seq: number } {
  return {
    type: 'terminal', runId: run.id, seq, timestamp: run.finishedAt ?? new Date().toISOString(),
    publicContent: run.errorMessage ?? '',
    terminal: {
      status: run.status as 'completed' | 'failed' | 'canceled',
      exitCode: run.exitCode,
      ...(run.errorCode ? { errorCode: run.errorCode } : {}),
    },
  };
}

function writeSse(reply: FastifyReply, event: PublicAgentEvent & { seq: number }): void {
  reply.raw.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
}

export function stripUnsafeHtml(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<(?:iframe|object|embed|form|base)\b[^>]*>[\s\S]*?<\/(?:iframe|object|embed|form|base)\s*>/gi, '')
    .replace(/<(?:meta|link)\b[^>]*>/gi, '')
    .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s(?:href|src)\s*=\s*(["'])\s*(?:javascript:|https?:|\/\/)[\s\S]*?\1/gi, '');
}

export function registerAgentRoutes(
  app: FastifyInstance,
  dbOnline: boolean,
  deps: { pool: Pool; orchestrator: AgentOrchestrator; reportRoot: string; enabled: boolean; config: EnvConfig },
) {
  const { orchestrator, enabled, config } = deps;
  const defaultMaxTurns = Number.parseInt(config.AGENT_DEFAULT_MAX_TURNS, 10) || 50;
  const defaultTimeoutMinutes = Number.parseInt(config.AGENT_TIMEOUT_MINUTES, 10) || 60;
  const defaultCodexTimeoutMinutes = Number.parseInt(config.AGENT_CODEX_TIMEOUT_MINUTES, 10) || 60;
  const messageSchema = z.object({
    prompt: z.string().trim().min(1).max(100_000),
    maxTurns: z.number().int().min(0).max(200).default(defaultMaxTurns),
    timeoutMinutes: z.number().int().min(1).max(360).optional(),
    templateStyle: z.enum(['classic-blue', 'dark-pro', 'minimal-white', 'dashboard']).default('classic-blue'),
    reportMode: z.literal('auto').default('auto'),
    // Kept temporarily so an older frontend does not fail validation. The agent now decides
    // from the task itself; this legacy switch no longer forces or suppresses a report.
    generateReport: z.boolean().optional(),
    provider: z.enum(['claude', 'codex']).optional(),
  });

  app.addHook('preHandler', async (request, reply) => {
    if (!request.url.startsWith('/api/agent')) return;
    if (!isLoopback(request)) return reply.code(403).send(apiError(ErrorCodes.INTERNAL_ERROR, '智能体接口仅允许本机访问'));
  });

  const ensureAvailable = (reply: FastifyReply) => {
    if (!enabled) { reply.code(503).send(apiError(ErrorCodes.INTERNAL_ERROR, '智能体系统未启用')); return false; }
    if (!dbOnline) { reply.code(503).send(dbUnavailable()); return false; }
    return true;
  };

  const startRun = async (body: z.infer<typeof messageSchema>, parent?: AgentRunRecord) => {
    const repo = new AgentRepository(deps.pool);
    const runId = crypto.randomUUID();
    const conversationId = parent?.conversationId ?? runId;
    const turnIndex = parent ? parent.turnIndex + 1 : 0;
    const provider: AgentProviderId = parent?.provider ?? body.provider ?? orchestrator.getDefaultProvider();
    const timeoutMinutes = body.timeoutMinutes
      ?? (provider === 'codex' ? defaultCodexTimeoutMinutes : defaultTimeoutMinutes);
    await repo.createRun(runId, body.prompt, body.maxTurns, timeoutMinutes * 60_000,
      body.templateStyle, parent?.id, conversationId, turnIndex, provider);
    if (parent?.sessionId) await repo.updateSessionId(runId, parent.sessionId);
    void orchestrator.start({
      runId, prompt: body.prompt, maxTurns: body.maxTurns, timeoutMs: timeoutMinutes * 60_000,
      templateStyle: body.templateStyle, resumeSessionId: parent?.sessionId ?? undefined,
      provider,
    }).catch(error => console.error(`[Agent] start failed for ${runId}:`, error));
    return { runId, conversationId, turnIndex, status: 'pending' as const, parentRunId: parent?.id ?? null };
  };

  app.post('/api/agent/runs', async (request, reply) => {
    if (!ensureAvailable(reply)) return;
    return reply.code(201).send(await startRun(messageSchema.parse(request.body)));
  });

  app.post('/api/agent/conversations/:conversationId/messages', async (request, reply) => {
    if (!ensureAvailable(reply)) return;
    const { conversationId } = request.params as { conversationId: string };
    const repo = new AgentRepository(deps.pool);
    const turns = await repo.listConversationTurns(conversationId, 1);
    const parent = turns[0];
    if (!parent) return reply.code(404).send(apiError(ErrorCodes.INTERNAL_ERROR, '对话不存在'));
    if (!TERMINAL.has(parent.status)) return reply.code(409).send(apiError(ErrorCodes.INTERNAL_ERROR, '上一轮尚未结束'));
    if (!parent.sessionId) return reply.code(409).send(apiError(ErrorCodes.INTERNAL_ERROR, '对话会话不可恢复'));
    const body = messageSchema.parse(request.body);
    if (body.provider && body.provider !== parent.provider) {
      return reply.code(409).send(apiError(ErrorCodes.PROVIDER_MISMATCH, '同一对话不能切换 Provider，请新建对话'));
    }
    return reply.code(201).send(await startRun(body, parent));
  });

  // Legacy continuation endpoint delegates to the same conversation model.
  app.post('/api/agent/runs/:runId/continue', async (request, reply) => {
    if (!ensureAvailable(reply)) return;
    const repo = new AgentRepository(deps.pool);
    const parent = await repo.getRun((request.params as { runId: string }).runId);
    if (!parent) return reply.code(404).send(apiError(ErrorCodes.INTERNAL_ERROR, '运行不存在'));
    if (!TERMINAL.has(parent.status) || !parent.sessionId) {
      return reply.code(409).send(apiError(ErrorCodes.INTERNAL_ERROR, '当前运行不可继续'));
    }
    const body = messageSchema.parse(request.body);
    if (body.provider && body.provider !== parent.provider) {
      return reply.code(409).send(apiError(ErrorCodes.PROVIDER_MISMATCH, '同一对话不能切换 Provider，请新建对话'));
    }
    return reply.code(201).send(await startRun(body, parent));
  });

  app.get('/api/agent/runs/:runId/stream', async (request, reply) => {
    if (!ensureAvailable(reply)) return;
    const { runId } = request.params as { runId: string };
    const repo = new AgentRepository(deps.pool);
    const run = await repo.getRun(runId);
    if (!run) return reply.code(404).send(apiError(ErrorCodes.INTERNAL_ERROR, '运行不存在'));
    const query = request.query as { lastEventId?: string };
    const headerId = request.headers['last-event-id'];
    let lastSent = Number.parseInt(String(headerId ?? query.lastEventId ?? '0'), 10) || 0;

    reply.hijack();
    const origin = typeof request.headers.origin === 'string' ? request.headers.origin : undefined;
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive', 'X-Accel-Buffering': 'no', 'X-Agent-Event-Protocol': 'agent-events-v2',
      ...(isLoopbackOrigin(origin) ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}),
    });
    // Flush headers immediately. Without an initial frame, browsers may remain in
    // CONNECTING until the first model event or 15-second heartbeat arrives.
    reply.raw.write(': connected\n\n');

    const pending = new Map<number, PublicAgentEvent & { seq: number }>();
    let replaying = true;
    let ended = false;
    const send = (event: PublicAgentEvent & { seq: number }) => {
      if (ended || event.seq <= lastSent) return;
      if (replaying) { pending.set(event.seq, event); return; }
      writeSse(reply, event); lastSent = event.seq;
      if (event.type === 'terminal') { ended = true; reply.raw.end(); }
    };
    const unsubscribe = orchestrator.addEventListener(runId, (event, seq) => send({ ...event, runId, seq }));
    const heartbeat = setInterval(() => { if (!ended) reply.raw.write(': heartbeat\n\n'); }, 15_000);
    const cleanup = () => { unsubscribe(); clearInterval(heartbeat); };
    request.raw.once('close', cleanup);

    const records = await repo.getEvents(runId, lastSent, 10_000);
    replaying = false;
    for (const event of publicEvents(records)) {
      send(event);
    }
    for (const event of [...pending.values()].sort((a, b) => a.seq - b.seq)) send(event);
    pending.clear();

    if (!ended) {
      const freshRun = await repo.getRun(runId);
      if (freshRun && TERMINAL.has(freshRun.status) && !records.some(record => record.eventType === 'terminal')) {
        send(synthesizedTerminal(freshRun, lastSent + 1));
      }
    }
    if (ended) cleanup();
  });

  app.post('/api/agent/runs/:runId/cancel', async (request, reply) => {
    if (!ensureAvailable(reply)) return;
    const { runId } = request.params as { runId: string };
    const canceled = await orchestrator.cancel(runId);
    if (!canceled) return reply.code(409).send(apiError(ErrorCodes.INTERNAL_ERROR, '运行已结束或不在当前进程中'));
    return reply.send({ runId, status: 'canceled' });
  });

  app.get('/api/agent/conversations', async (request, reply) => {
    const query = request.query as { cursor?: string; limit?: string };
    const limit = Math.max(1, Math.min(100, Number.parseInt(query.limit ?? '30', 10) || 30));
    const runs = await new AgentRepository(deps.pool).listConversations(limit + 1, query.cursor);
    const hasMore = runs.length > limit;
    const items = runs.slice(0, limit);
    return reply.send({ conversations: items, nextCursor: hasMore ? items.at(-1)?.createdAt ?? null : null });
  });

  app.get('/api/agent/metrics', async (_request, reply) => {
    return reply.send({
      runtime: enabled ? orchestrator.getRuntimeStats() : { active: 0, capacity: 0 },
      providers: enabled ? orchestrator.getProviderHealth() : [],
      defaultProvider: enabled ? orchestrator.getDefaultProvider() : 'claude',
      persistence: await new AgentRepository(deps.pool).getMetrics(),
      observedAt: new Date().toISOString(),
    });
  });

  app.get('/api/agent/approvals', async (request, reply) => {
    if (!ensureAvailable(reply)) return;
    const { runId } = request.query as { runId?: string };
    return reply.send({ approvals: await orchestrator.listPendingApprovals(runId) });
  });

  app.post('/api/agent/approvals/:approvalId/decision', async (request, reply) => {
    if (!ensureAvailable(reply)) return;
    const { approvalId } = z.object({ approvalId: z.string().uuid() }).parse(request.params);
    const { decision } = z.object({ decision: z.enum(['approved', 'denied']) }).parse(request.body);
    const approval = await orchestrator.decideApproval(approvalId, decision);
    if (!approval) return reply.code(404).send(apiError(ErrorCodes.INTERNAL_ERROR, '审批请求不存在'));
    if (approval.status !== decision) {
      return reply.code(409).send(apiError(ErrorCodes.INTERNAL_ERROR, `审批已处于 ${approval.status} 状态`));
    }
    return reply.send({ approval });
  });

  app.get('/api/agent/providers', async (_request, reply) => {
    if (!ensureAvailable(reply)) return;
    return reply.send({
      defaultProvider: orchestrator.getDefaultProvider(),
      providers: orchestrator.getProviderHealth(),
    });
  });

  app.get('/api/agent/conversations/:conversationId/turns', async (request, reply) => {
    const { conversationId } = request.params as { conversationId: string };
    const query = request.query as { cursor?: string; limit?: string };
    const limit = Math.max(1, Math.min(100, Number.parseInt(query.limit ?? '20', 10) || 20));
    const before = query.cursor == null ? undefined : Number.parseInt(query.cursor, 10);
    const repo = new AgentRepository(deps.pool);
    const runs = await repo.listConversationTurns(conversationId, limit + 1, Number.isFinite(before) ? before : undefined);
    const hasMore = runs.length > limit;
    const selected = hasMore ? runs.slice(1) : runs;
    const turns = await Promise.all(selected.map(async run => ({
      run,
      events: eventsWithTerminal(run, await repo.getEvents(run.id, -1, 300)),
      report: await repo.getReport(run.id),
    })));
    return reply.send({ turns, nextCursor: hasMore ? selected[0]?.turnIndex ?? null : null });
  });

  app.get('/api/agent/runs/:runId/events', async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const query = request.query as { afterSeq?: string; limit?: string };
    const events = await new AgentRepository(deps.pool).getEvents(
      runId, Number.parseInt(query.afterSeq ?? '-1', 10), Number.parseInt(query.limit ?? '100', 10),
    );
    return reply.send({ events: publicEvents(events) });
  });

  // Legacy history endpoints remain available during the v1 transition.
  app.get('/api/agent/runs', async (request, reply) => {
    const query = request.query as { status?: string; limit?: string; offset?: string };
    const runs = await new AgentRepository(deps.pool).listRuns(
      Number.parseInt(query.limit ?? '50', 10), Number.parseInt(query.offset ?? '0', 10), query.status,
    );
    return reply.send({ runs });
  });
  app.get('/api/agent/runs/:runId/conversation', async (request, reply) => {
    const repo = new AgentRepository(deps.pool);
    const runs = await repo.getRunChain((request.params as { runId: string }).runId);
    if (!runs.length) return reply.code(404).send(apiError(ErrorCodes.INTERNAL_ERROR, '对话不存在'));
    const turns = await Promise.all(runs.map(async run => ({ run,
      events: eventsWithTerminal(run, await repo.getEvents(run.id)), report: await repo.getReport(run.id) })));
    return reply.send({ turns });
  });
  app.get('/api/agent/runs/:runId', async (request, reply) => {
    const runId = (request.params as { runId: string }).runId;
    const repo = new AgentRepository(deps.pool);
    const run = await repo.getRun(runId);
    if (!run) return reply.code(404).send(apiError(ErrorCodes.INTERNAL_ERROR, '运行不存在'));
    return reply.send({ run, events: eventsWithTerminal(run, await repo.getEvents(runId)), report: await repo.getReport(runId) });
  });

  app.delete('/api/agent/runs/:runId', async (request, reply) => {
    if (!ensureAvailable(reply)) return;
    const runId = (request.params as { runId: string }).runId;
    if (orchestrator.isRunning(runId)) return reply.code(409).send(apiError(ErrorCodes.INTERNAL_ERROR, '请先取消运行'));
    const repo = new AgentRepository(deps.pool);
    const report = await repo.getReport(runId);
    if (report?.htmlPath) await unlink(report.htmlPath).catch(() => undefined);
    await repo.deleteRun(runId);
    return reply.send({ runId, deleted: true });
  });

  const loadReport = async (runId: string) => {
    const report = await new AgentRepository(deps.pool).getReport(runId);
    if (!report) return null;
    const root = resolve(deps.reportRoot, 'reports');
    const path = resolve(report.htmlPath);
    const rel = relative(root, path);
    if (!isAbsolute(path) || rel.startsWith('..') || isAbsolute(rel) || path !== resolve(root, `${runId}.html`)) return null;
    return { report, html: await readFile(path, 'utf8') };
  };
  app.get('/api/agent/reports/:runId', async (request, reply) => {
    const report = await new AgentRepository(deps.pool).getReport((request.params as { runId: string }).runId);
    return report ? reply.send(report) : reply.code(404).send(apiError(ErrorCodes.INTERNAL_ERROR, '报告不存在'));
  });
  app.get('/api/agent/reports/:runId/html', async (request, reply) => {
    try {
      const loaded = await loadReport((request.params as { runId: string }).runId);
      if (!loaded) return reply.code(404).send(apiError(ErrorCodes.INTERNAL_ERROR, '报告不存在'));
      reply.headers({
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:",
        'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
        'Cross-Origin-Resource-Policy': 'same-origin',
      });
      return reply.send(stripUnsafeHtml(loaded.html));
    } catch { return reply.code(404).send(apiError(ErrorCodes.INTERNAL_ERROR, '报告文件不存在')); }
  });
  app.get('/api/agent/reports/:runId/download', async (request, reply) => {
    try {
      const loaded = await loadReport((request.params as { runId: string }).runId);
      if (!loaded) return reply.code(404).send(apiError(ErrorCodes.INTERNAL_ERROR, '报告不存在'));
      reply.header('Content-Type', 'application/octet-stream');
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('Content-Disposition', `attachment; filename="${encodeURIComponent(loaded.report.title)}.html"`);
      return reply.send(loaded.html);
    } catch { return reply.code(404).send(apiError(ErrorCodes.INTERNAL_ERROR, '报告文件不存在')); }
  });
  app.get('/api/agent/reports', async (request, reply) => {
    const query = request.query as { limit?: string; offset?: string };
    return reply.send({ reports: await new AgentRepository(deps.pool).listReports(
      Number.parseInt(query.limit ?? '50', 10), Number.parseInt(query.offset ?? '0', 10)) });
  });
}
