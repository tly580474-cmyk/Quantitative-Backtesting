import type { FastifyInstance } from 'fastify';
import type { Pool } from 'mysql2/promise';
import { readFile, unlink } from 'fs/promises';
import { z } from 'zod';
import { ErrorCodes, apiError, dbUnavailable } from '../validation/errors.js';
import { AgentRepository } from '../services/agent/agentRepository.js';
import type { AgentOrchestrator } from '../services/agent/agentOrchestrator.js';

const createRunBodySchema = z.object({
  prompt: z.string().min(1),
  maxTurns: z.number().int().min(0).max(200).default(0),
  timeoutMinutes: z.number().int().min(1).max(120).default(30),
  templateStyle: z.enum(['classic-blue', 'dark-pro', 'minimal-white', 'dashboard']).default('classic-blue'),
});

const continueBodySchema = z.object({
  prompt: z.string().min(1),
  maxTurns: z.number().int().min(0).max(200).default(0),
  timeoutMinutes: z.number().int().min(1).max(120).default(30),
  templateStyle: z.enum(['classic-blue', 'dark-pro', 'minimal-white', 'dashboard']).default('classic-blue'),
});

export function registerAgentRoutes(
  app: FastifyInstance,
  dbOnline: boolean,
  deps: {
    pool: Pool;
    orchestrator: AgentOrchestrator;
    reportRoot: string;
    enabled: boolean;
  },
) {
  const { orchestrator, enabled } = deps;

  // POST /api/agent/runs — 创建并启动 agent
  app.post('/api/agent/runs', async (request, reply) => {
    if (!enabled) {
      return reply.code(503).send(apiError(ErrorCodes.INTERNAL_ERROR, 'Agent 系统未启用'));
    }
    if (!dbOnline) {
      return reply.code(503).send(dbUnavailable());
    }

    const body = createRunBodySchema.parse(request.body);
    const runId = crypto.randomUUID();
    const repo = new AgentRepository(deps.pool);

    await repo.createRun(runId, body.prompt, body.maxTurns, body.timeoutMinutes * 60_000, body.templateStyle);

    // Start asynchronously (non-blocking)
    orchestrator.start({
      runId,
      prompt: body.prompt,
      maxTurns: body.maxTurns,
      timeoutMs: body.timeoutMinutes * 60_000,
      templateStyle: body.templateStyle,
    }).catch(err => {
      console.error(`[Agent] Failed to start run ${runId}:`, err);
      repo.updateRunStatus(runId, 'failed', { errorMessage: err.message }).catch(() => {});
    });

    return reply.code(201).send({ runId, status: 'pending' });
  });

  // GET /api/agent/runs/:runId/stream — SSE 实时事件流
  app.get('/api/agent/runs/:runId/stream', async (request, reply) => {
    const { runId } = request.params as { runId: string };

    const origin = request.headers.origin || '*';
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': origin,
    });

    const repo = new AgentRepository(deps.pool);

    // Get Last-Event-ID for reconnection
    const lastEventId = request.headers['last-event-id'];
    const startSeq = lastEventId ? parseInt(lastEventId as string, 10) + 1 : 0;

    // Send historical events first (only those after lastEventId)
    const events = await repo.getEvents(runId);
    for (const event of events) {
      if (event.seq < startSeq) continue;  // skip already-sent events
      reply.raw.write(`id: ${event.seq}\n`);
      reply.raw.write(`data: ${JSON.stringify({
        type: event.eventType,
        content: event.content,
        toolName: event.toolName,
        toolInput: event.toolInput,
        toolResult: event.toolResult,
        seq: event.seq,
        timestamp: event.createdAt,
      })}\n\n`);
    }

    // Check if run is still active
    const run = await repo.getRun(runId);
    if (!run) {
      reply.raw.write(`event: error\ndata: ${JSON.stringify({ message: '运行不存在' })}\n\n`);
      reply.raw.end();
      return;
    }

    if (run.status === 'completed' || run.status === 'failed' || run.status === 'canceled') {
      // Send done event with exit code
      reply.raw.write(`event: done\ndata: ${JSON.stringify({
        exitCode: run.exitCode,
        status: run.status,
      })}\n\n`);

      // Check for report
      const report = await repo.getReport(runId);
      if (report) {
        reply.raw.write(`event: text\ndata: ${JSON.stringify({
          title: report.title,
          summary: report.summary,
        })}\n\n`);
      }

      reply.raw.end();
      return;
    }

    // Heartbeat to keep connection alive
    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(`: heartbeat\n\n`);
      } catch {
        clearInterval(heartbeat);
      }
    }, 15000);

    // Subscribe to live events
    const unsubscribe = orchestrator.addEventListener(runId, (event, seq) => {
      reply.raw.write(`id: ${seq}\n`);
      reply.raw.write(`data: ${JSON.stringify({
        type: event.type,
        content: event.content,
        toolName: event.toolName,
        toolInput: event.toolInput,
        toolResult: event.toolResult,
        timestamp: event.timestamp,
      })}\n\n`);

      if (event.type === 'done') {
        clearInterval(heartbeat);
        // Check for report
        repo.getReport(runId).then(report => {
          if (report) {
            reply.raw.write(`event: text\ndata: ${JSON.stringify({
              title: report.title,
              summary: report.summary,
            })}\n\n`);
          }
          reply.raw.write(`event: done\ndata: ${JSON.stringify({ exitCode: 0 })}\n\n`);
          reply.raw.end();
        }).catch(() => {
          reply.raw.end();
        });
      }
    });

    // Handle client disconnect
    request.raw.on('close', () => {
      unsubscribe();
      clearInterval(heartbeat);
    });
  });

  // POST /api/agent/runs/:runId/cancel — 取消运行
  app.post('/api/agent/runs/:runId/cancel', async (request, reply) => {
    const { runId } = request.params as { runId: string };
    orchestrator.cancel(runId);
    const repo = new AgentRepository(deps.pool);
    await repo.updateRunStatus(runId, 'canceled');
    return reply.send({ runId, status: 'canceled' });
  });

  // DELETE /api/agent/runs/:runId — 删除历史运行
  app.delete('/api/agent/runs/:runId', async (request, reply) => {
    if (!enabled) {
      return reply.code(503).send(apiError(ErrorCodes.INTERNAL_ERROR, 'Agent 系统未启用'));
    }
    const { runId } = request.params as { runId: string };
    const repo = new AgentRepository(deps.pool);

    // Don't allow deleting a running task
    if (orchestrator.isRunning(runId)) {
      return reply.code(409).send(apiError(ErrorCodes.INTERNAL_ERROR, '运行中的任务无法删除，请先取消'));
    }

    // Try to delete the report HTML file
    const report = await repo.getReport(runId);
    if (report?.htmlPath) {
      unlink(report.htmlPath).catch(() => {});
    }

    await repo.deleteRun(runId);
    return reply.send({ runId, deleted: true });
  });

  // POST /api/agent/runs/:runId/continue — 接着历史任务继续工作
  app.post('/api/agent/runs/:runId/continue', async (request, reply) => {
    if (!enabled) {
      return reply.code(503).send(apiError(ErrorCodes.INTERNAL_ERROR, 'Agent 系统未启用'));
    }
    if (!dbOnline) {
      return reply.code(503).send(dbUnavailable());
    }

    const { runId: parentRunId } = request.params as { runId: string };
    const body = continueBodySchema.parse(request.body);
    const repo = new AgentRepository(deps.pool);

    // Get parent run to retrieve session_id
    const parentRun = await repo.getRun(parentRunId);
    if (!parentRun) {
      return reply.code(404).send(apiError(ErrorCodes.INTERNAL_ERROR, '原始运行不存在'));
    }
    if (!parentRun.sessionId) {
      return reply.code(400).send(apiError(ErrorCodes.INTERNAL_ERROR, '原始运行无会话ID，无法继续'));
    }

    const newRunId = crypto.randomUUID();
    await repo.createRun(newRunId, body.prompt, body.maxTurns, body.timeoutMinutes * 60_000, body.templateStyle, parentRunId);

    orchestrator.start({
      runId: newRunId,
      prompt: body.prompt,
      maxTurns: body.maxTurns,
      timeoutMs: body.timeoutMinutes * 60_000,
      templateStyle: body.templateStyle,
      resumeSessionId: parentRun.sessionId,
    }).catch(err => {
      console.error(`[Agent] Failed to start continuation run ${newRunId}:`, err);
      repo.updateRunStatus(newRunId, 'failed', { errorMessage: err.message }).catch(() => {});
    });

    return reply.code(201).send({ runId: newRunId, status: 'pending', parentRunId });
  });

  // GET /api/agent/runs — 列出历史运行
  app.get('/api/agent/runs', async (request, reply) => {
    const query = request.query as { status?: string; limit?: string; offset?: string };
    const limit = Math.min(parseInt(query.limit ?? '50', 10) || 50, 200);
    const offset = parseInt(query.offset ?? '0', 10) || 0;
    const repo = new AgentRepository(deps.pool);
    const runs = await repo.listRuns(limit, offset, query.status);
    return reply.send({ runs });
  });

  // GET /api/agent/runs/:runId — 获取运行详情
  app.get('/api/agent/runs/:runId', async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const repo = new AgentRepository(deps.pool);
    const [run, events, report] = await Promise.all([
      repo.getRun(runId),
      repo.getEvents(runId),
      repo.getReport(runId),
    ]);
    if (!run) {
      return reply.code(404).send(apiError(ErrorCodes.INTERNAL_ERROR, '运行不存在'));
    }
    return reply.send({ run, events, report });
  });

  // GET /api/agent/reports/:runId — 获取报告元信息
  app.get('/api/agent/reports/:runId', async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const repo = new AgentRepository(deps.pool);
    const report = await repo.getReport(runId);
    if (!report) {
      return reply.code(404).send(apiError(ErrorCodes.INTERNAL_ERROR, '报告不存在'));
    }
    return reply.send(report);
  });

  // GET /api/agent/reports/:runId/html — 获取 HTML 报告内容
  app.get('/api/agent/reports/:runId/html', async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const repo = new AgentRepository(deps.pool);
    const report = await repo.getReport(runId);
    if (!report) {
      return reply.code(404).send(apiError(ErrorCodes.INTERNAL_ERROR, '报告不存在'));
    }
    try {
      const html = await readFile(report.htmlPath);
      reply.header('Content-Type', 'text/html; charset=utf-8');
      reply.header('Content-Disposition', `inline; filename="${encodeURIComponent(report.title)}.html"`);
      return reply.send(html);
    } catch {
      return reply.code(404).send(apiError(ErrorCodes.INTERNAL_ERROR, '报告文件不存在'));
    }
  });

  // GET /api/agent/reports/:runId/download — 下载 HTML 报告
  app.get('/api/agent/reports/:runId/download', async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const repo = new AgentRepository(deps.pool);
    const report = await repo.getReport(runId);
    if (!report) {
      return reply.code(404).send(apiError(ErrorCodes.INTERNAL_ERROR, '报告不存在'));
    }
    try {
      const html = await readFile(report.htmlPath);
      reply.header('Content-Type', 'text/html; charset=utf-8');
      reply.header('Content-Disposition', `attachment; filename="${encodeURIComponent(report.title)}.html"`);
      return reply.send(html);
    } catch {
      return reply.code(404).send(apiError(ErrorCodes.INTERNAL_ERROR, '报告文件不存在'));
    }
  });

  // GET /api/agent/reports — 列出所有报告
  app.get('/api/agent/reports', async (request, reply) => {
    const query = request.query as { limit?: string; offset?: string };
    const limit = Math.min(parseInt(query.limit ?? '50', 10) || 50, 200);
    const offset = parseInt(query.offset ?? '0', 10) || 0;
    const repo = new AgentRepository(deps.pool);
    const reports = await repo.listReports(limit, offset);
    return reply.send({ reports });
  });
}
