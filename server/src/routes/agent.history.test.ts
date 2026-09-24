import Fastify from 'fastify';
import type { Pool } from 'mysql2/promise';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import type { AgentOrchestrator } from '../services/agent/agentOrchestrator.js';
import { registerAgentRoutes } from './agent.js';

describe('complete agent history replay', () => {
  it.each([
    ['/api/agent/conversations/run-long/turns', 305, 'pi', true],
    ['/api/agent/conversations/run-long/turns', 315, 'pi', false],
    ['/api/agent/conversations/run-long/turns', 10_005, 'codex', true],
    ['/api/agent/runs/run-long/conversation', 10_005, 'pi', true],
    ['/api/agent/runs/run-long', 10_005, 'pi', false],
  ])('returns final content beyond the old limit: %s, seq %s', async (url, finalSeq, provider, storedTerminal) => {
    const run = { id: 'run-long', conversation_id: 'run-long', turn_index: 0, provider,
      status: 'completed', prompt: 'Long research', protocol_version: 2, exit_code: 0,
      created_at: '2026-09-24T12:00:00Z', finished_at: '2026-09-24T12:17:00Z' };
    const records = Array.from({ length: finalSeq + Number(storedTerminal) }, (_, i) => ({
      run_id: run.id, seq: i + 1, protocol_version: 2,
      event_type: i + 1 === finalSeq ? 'assistant_final' : i + 1 > finalSeq ? 'terminal' : 'progress',
      content: i + 1 === finalSeq ? '完整历史结论' : '',
      terminal_json: i + 1 > finalSeq ? JSON.stringify({ status: 'completed', exitCode: 0 }) : null,
      created_at: run.created_at,
    }));
    const sql = async (query: string, params: unknown[] = []) => {
      if (query.includes('MAX(seq)')) return [[{ seq: records.at(-1)!.seq }]];
      if (query.includes('FROM agent_events')) {
        const limit = Number(query.match(/LIMIT (\d+)/)?.[1] ?? records.length);
        return [records.filter(r => r.seq > Number(params[1])).slice(0, limit)];
      }
      if (query.includes('FROM agent_runs')) return [[run]];
      return [[]];
    };
    const app = Fastify();
    registerAgentRoutes(app, true, { pool: { execute: sql, query: sql } as unknown as Pool,
      orchestrator: {} as AgentOrchestrator, reportRoot: '.', enabled: true, config: loadConfig() });
    try {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      const events = (body.turns ? body.turns[0] : body).events;
      expect(events).toHaveLength(finalSeq + 1);
      expect(events.at(-2)).toMatchObject({ type: 'assistant_final', seq: finalSeq, publicContent: '完整历史结论' });
      expect(events.filter((e: { type: string }) => e.type === 'terminal')).toHaveLength(1);
      expect(events.at(-1)).toMatchObject({ type: 'terminal', seq: finalSeq + 1 });
    } finally { await app.close(); }
  });
});
