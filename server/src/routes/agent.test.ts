import Fastify from 'fastify';
import type { Pool } from 'mysql2/promise';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { isLoopbackOrigin, registerAgentRoutes, stripUnsafeHtml } from './agent.js';

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
});
