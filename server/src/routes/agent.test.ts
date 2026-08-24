import Fastify from 'fastify';
import type { Pool } from 'mysql2/promise';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { isLoopbackOrigin, registerAgentRoutes, stripUnsafeHtml } from './agent.js';
import type { AgentOrchestrator } from '../services/agent/agentOrchestrator.js';

describe('agent report isolation', () => {
  it('removes active content and remote navigation from generated reports', () => {
    const dirty = `<!doctype html><html><head><script>alert(document.cookie)</script>
      <meta http-equiv="refresh" content="0;url=https://evil.test"></head><body onload="steal()">
      <a href="javascript:steal()">x</a><iframe src="https://evil.test"></iframe><p>safe</p></body></html>`;
    const clean = stripUnsafeHtml(dirty);
    expect(clean).toContain('<p>safe</p>');
    expect(clean).not.toMatch(/script|iframe|onload|javascript:|meta/i);
  });
});

describe('agent route boundary', () => {
  it('allows only loopback browser origins for raw SSE responses', () => {
    expect(isLoopbackOrigin('http://127.0.0.1:5558')).toBe(true);
    expect(isLoopbackOrigin('http://localhost:5173')).toBe(true);
    expect(isLoopbackOrigin('http://[::1]:5558')).toBe(true);
    expect(isLoopbackOrigin('https://example.com')).toBe(false);
  });
  it('returns 503 when the agent feature is disabled', async () => {
    const app = Fastify();
    registerAgentRoutes(app, true, {
      pool: {} as Pool, orchestrator: null as never, reportRoot: '.', enabled: false, config: loadConfig(),
    });
    const response = await app.inject({ method: 'POST', url: '/api/agent/runs', payload: { prompt: 'test' } });
    expect(response.statusCode).toBe(503);
    await app.close();
  });

  it('rejects non-loopback callers before route execution', async () => {
    const app = Fastify();
    registerAgentRoutes(app, true, {
      pool: {} as Pool, orchestrator: null as never, reportRoot: '.', enabled: false, config: loadConfig(),
    });
    const response = await app.inject({ method: 'GET', url: '/api/agent/conversations', remoteAddress: '192.168.1.55' });
    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it('rejects switching provider while continuing an existing conversation', async () => {
    const app = Fastify();
    const execute = async (sql: string) => {
      if (sql.includes('SELECT * FROM agent_runs WHERE id')) return [[{
        id: 'run-1', prompt: 'root', status: 'completed', max_turns: 5, template_style: 'classic-blue',
        timeout_ms: 60_000, pid: null, provider: 'claude', session_id: 'session-1', parent_run_id: null,
        conversation_id: 'run-1', turn_index: 0, protocol_version: 2, exit_code: 0,
        error_message: null, error_code: null, created_at: new Date().toISOString(),
        started_at: null, finished_at: null,
      }]];
      return [[]];
    };
    const orchestrator = {
      getDefaultProvider: () => 'claude',
      getProviderHealth: () => [],
      getRuntimeStats: () => ({ active: 0, capacity: 1 }),
    } as unknown as AgentOrchestrator;
    registerAgentRoutes(app, true, {
      pool: { execute } as unknown as Pool, orchestrator, reportRoot: '.', enabled: true, config: loadConfig(),
    });
    const response = await app.inject({
      method: 'POST', url: '/api/agent/runs/run-1/continue',
      payload: { prompt: 'continue', provider: 'codex' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'PROVIDER_MISMATCH' });
    await app.close();
  });

  it('ignores legacy turn and report-style fields and always starts without a turn limit', async () => {
    const app = Fastify();
    let insertParams: unknown[] = [];
    let startParams: Record<string, unknown> | undefined;
    const pool = {
      execute: async (sql: string, params?: unknown[]) => {
        if (sql.includes('INSERT INTO agent_runs')) insertParams = params ?? [];
        return [{}];
      },
    } as unknown as Pool;
    const orchestrator = {
      getDefaultProvider: () => 'claude',
      start: async (params: Record<string, unknown>) => { startParams = params; },
    } as unknown as AgentOrchestrator;
    registerAgentRoutes(app, true, {
      pool, orchestrator, reportRoot: '.', enabled: true, config: loadConfig(),
    });

    const response = await app.inject({
      method: 'POST', url: '/api/agent/runs',
      payload: {
        prompt: 'research', provider: 'codex', maxTurns: 3,
        templateStyle: 'dark-pro', reportMode: 'auto', generateReport: true,
      },
    });

    expect(response.statusCode).toBe(201);
    expect(insertParams[2]).toBe(0);
    expect(insertParams[4]).toBe('classic-blue');
    expect(startParams).toMatchObject({ maxTurns: 0, templateStyle: 'classic-blue', provider: 'codex' });
    await app.close();
  });

  it('accepts an idempotent approval decision through the public approval id', async () => {
    const app = Fastify();
    const approvalId = '72d6bc2b-c3e9-4c01-88b6-6c04610df31e';
    const decideApproval = async (id: string, decision: string) => ({
      id, runId: 'run-approval', provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1',
      requestType: 'command', summary: '运行检查命令', status: decision,
      expiresAt: new Date(Date.now() + 60_000).toISOString(), decisionAt: new Date().toISOString(),
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    registerAgentRoutes(app, true, {
      pool: {} as Pool,
      orchestrator: { decideApproval } as unknown as AgentOrchestrator,
      reportRoot: '.', enabled: true, config: loadConfig(),
    });
    const response = await app.inject({
      method: 'POST', url: `/api/agent/approvals/${approvalId}/decision`, payload: { decision: 'approved' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().approval).toMatchObject({ id: approvalId, status: 'approved', runId: 'run-approval' });
    await app.close();
  });

  it('retries a failed task only through the explicit retry endpoint', async () => {
    const app = Fastify();
    const failedRun = {
      id: 'run-failed', prompt: '研究失败任务', status: 'failed', max_turns: 0, template_style: 'classic-blue',
      timeout_ms: 60_000, pid: null, provider: 'codex', session_id: 'thread-1', parent_run_id: null,
      conversation_id: 'conversation-1', turn_index: 0, protocol_version: 2, exit_code: 1,
      error_message: '连接失败', error_code: 'PROVIDER_ERROR', created_at: new Date().toISOString(),
      started_at: null, finished_at: new Date().toISOString(),
    };
    const pool = {
      execute: async (sql: string) => {
        if (sql.includes('SELECT * FROM agent_runs WHERE id')) return [[failedRun]];
        if (sql.includes('SELECT * FROM agent_attachments WHERE run_id')) return [[]];
        return [{ affectedRows: 1 }];
      },
      query: async (sql: string) => sql.includes('SELECT * FROM agent_runs WHERE conversation_id')
        ? [[failedRun]] : [[]],
    } as unknown as Pool;
    let startParams: Record<string, unknown> | undefined;
    const orchestrator = {
      getDefaultProvider: () => 'claude',
      start: async (params: Record<string, unknown>) => { startParams = params; },
    } as unknown as AgentOrchestrator;
    registerAgentRoutes(app, true, {
      pool, orchestrator, reportRoot: '.', enabled: true, config: loadConfig(),
    });

    const response = await app.inject({ method: 'POST', url: '/api/agent/runs/run-failed/retry' });

    expect(response.statusCode).toBe(201);
    expect(response.json().prompt).toContain('重试上一轮任务');
    expect(startParams).toMatchObject({ provider: 'codex', resumeSessionId: 'thread-1' });
    await app.close();
  });

  it('deletes every finalized turn through the conversation endpoint', async () => {
    const app = Fastify();
    const baseRun = {
      prompt: '研究任务', status: 'completed', max_turns: 0, template_style: 'classic-blue',
      timeout_ms: 60_000, pid: null, provider: 'codex', session_id: 'thread-1',
      conversation_id: 'conversation-1', protocol_version: 2, exit_code: 0,
      error_message: null, error_code: null, created_at: new Date().toISOString(),
      started_at: null, finished_at: new Date().toISOString(),
    };
    const runs = [
      { ...baseRun, id: 'run-1', parent_run_id: null, turn_index: 0 },
      { ...baseRun, id: 'run-2', parent_run_id: 'run-1', turn_index: 1 },
    ];
    const transactionSql: string[] = [];
    const connection = {
      beginTransaction: async () => undefined,
      execute: async (sql: string) => {
        transactionSql.push(sql);
        return sql.includes('SELECT id FROM agent_runs')
          ? [[{ id: 'run-1' }, { id: 'run-2' }]]
          : [{ affectedRows: 2 }];
      },
      commit: async () => undefined,
      rollback: async () => undefined,
      release: () => undefined,
    };
    const pool = {
      execute: async (sql: string) => {
        if (sql.includes('SELECT * FROM agent_runs WHERE conversation_id')) return [runs];
        return [[]];
      },
      getConnection: async () => connection,
    } as unknown as Pool;
    const orchestrator = { isRunning: () => false } as unknown as AgentOrchestrator;
    registerAgentRoutes(app, true, {
      pool, orchestrator, reportRoot: '.', enabled: true, config: loadConfig(),
    });

    const response = await app.inject({
      method: 'DELETE', url: '/api/agent/conversations/conversation-1',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ conversationId: 'conversation-1', deletedRuns: 2 });
    expect(transactionSql).toContain('DELETE FROM agent_runs WHERE conversation_id = ?');
    await app.close();
  });
});
