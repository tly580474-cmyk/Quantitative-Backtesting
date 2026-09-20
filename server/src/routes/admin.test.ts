import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'mysql2/promise';
import { loadConfig } from '../config.js';
import { registerAdminRoutes } from './admin.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const previousToken = process.env.ADMIN_API_TOKEN;

afterEach(() => {
  vi.useRealTimers();
  if (previousToken === undefined) delete process.env.ADMIN_API_TOKEN;
  else process.env.ADMIN_API_TOKEN = previousToken;
});

describe('admin routes', () => {
  it('exposes Pi readiness only to admins without exposing its credentials', async () => {
    process.env.ADMIN_API_TOKEN = 'test-admin-token';
    const directory = await mkdtemp(join(tmpdir(), 'admin-pi-'));
    const app = Fastify();
    try {
      await writeFile(join(directory, 'auth.json'), '{"apiKey":"never-expose-this-credential"}');
      registerAdminRoutes(app, { pool: {} as Pool, dbOnline: false, envFilePath: '.env',
        config: { ...loadConfig(), AGENT_PROVIDER: 'pi', AGENT_PI_ENABLED: 'true',
          AGENT_PI_PATH: process.execPath, AGENT_CODEX_PATH: process.execPath,
          AGENT_PI_AGENT_DIRECTORY: directory, AGENT_PI_MODEL: 'test-model', AGENT_PI_MODEL_PROVIDER: 'test-source' },
      });
      expect((await app.inject({ method: 'GET', url: '/api/admin/agent' })).statusCode).toBe(401);
      const response = await app.inject({ method: 'GET', url: '/api/admin/agent',
        headers: { authorization: 'Bearer test-admin-token' } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ defaultProvider: 'pi', pi: { enabled: true,
        version: expect.any(String), model: 'test-model', modelProvider: 'test-source',
        configurationDirectoryConfigured: true, authFileReadable: true, latestRun: null } });
      expect(response.body).not.toContain('never-expose-this-credential');
      expect(response.body).not.toContain(directory.replaceAll('\\', '\\\\'));
    } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it('reports disabled state when no token is configured', async () => {
    process.env.ADMIN_API_TOKEN = '';
    const app = Fastify();
    registerAdminRoutes(app, {
      pool: {} as Pool,
      dbOnline: false,
      config: loadConfig(),
      envFilePath: '.env',
    });
    const status = await app.inject({ method: 'GET', url: '/api/admin/auth/status' });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toEqual({ enabled: false });
    const verify = await app.inject({ method: 'POST', url: '/api/admin/auth/verify' });
    expect(verify.statusCode).toBe(503);
    await app.close();
  });

  it('requires an exact bearer token', async () => {
    process.env.ADMIN_API_TOKEN = 'test-admin-token';
    const app = Fastify();
    registerAdminRoutes(app, {
      pool: {} as Pool,
      dbOnline: false,
      config: loadConfig(),
      envFilePath: '.env',
    });
    const rejected = await app.inject({
      method: 'POST',
      url: '/api/admin/auth/verify',
      headers: { authorization: 'Bearer wrong-token' },
    });
    expect(rejected.statusCode).toBe(401);
    const accepted = await app.inject({
      method: 'POST',
      url: '/api/admin/auth/verify',
      headers: { authorization: 'Bearer test-admin-token' },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toEqual({ authenticated: true });
    await app.close();
  });

  it('reports restart unavailable without the backend supervisor', async () => {
    process.env.ADMIN_API_TOKEN = 'test-admin-token';
    const app = Fastify();
    registerAdminRoutes(app, {
      pool: {} as Pool,
      dbOnline: false,
      config: loadConfig(),
      envFilePath: '.env',
    });
    const status = await app.inject({
      method: 'GET', url: '/api/admin/restart/status',
      headers: { authorization: 'Bearer test-admin-token' },
    });
    expect(status.statusCode).toBe(200);
    expect(status.json().available).toBe(false);
    const restart = await app.inject({
      method: 'POST', url: '/api/admin/restart',
      headers: { authorization: 'Bearer test-admin-token' },
    });
    expect(restart.statusCode).toBe(409);
    await app.close();
  });

  it('exposes fund-flow, minute-lake, daily K-line, and financial progress only to authenticated admins', async () => {
    process.env.ADMIN_API_TOKEN = 'test-admin-token';
    const app = Fastify();
    registerAdminRoutes(app, {
      pool: {} as Pool,
      dbOnline: false,
      config: loadConfig(),
      envFilePath: '.env',
    });
    const rejected = await app.inject({ method: 'GET', url: '/api/admin/data-update-progress' });
    expect(rejected.statusCode).toBe(401);
    const accepted = await app.inject({
      method: 'GET', url: '/api/admin/data-update-progress',
      headers: { authorization: 'Bearer test-admin-token' },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().items.map((item: { key: string }) => item.key)).toEqual([
      'fund_flow',
      'instrument_master',
      'minute_lake',
      'daily_kline',
      'financial_reports',
    ]);
    await app.close();
  });

  it('accepts a supervised restart and schedules it after the response', async () => {
    vi.useFakeTimers();
    process.env.ADMIN_API_TOKEN = 'test-admin-token';
    const requestRestart = vi.fn();
    const app = Fastify();
    registerAdminRoutes(app, {
      pool: {} as Pool,
      dbOnline: false,
      config: loadConfig(),
      envFilePath: '.env',
      restart: { available: true, request: requestRestart },
    });
    const restart = await app.inject({
      method: 'POST', url: '/api/admin/restart',
      headers: { authorization: 'Bearer test-admin-token' },
    });
    expect(restart.statusCode).toBe(202);
    expect(restart.json().accepted).toBe(true);
    expect(requestRestart).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);
    expect(requestRestart).toHaveBeenCalledOnce();
    await app.close();
  });

  it('reads and toggles public access only for authenticated admins', async () => {
    process.env.ADMIN_API_TOKEN = 'test-admin-token';
    const setEnabled = vi.fn(async (enabled: boolean) => ({
      available: true,
      enabled,
      running: enabled,
      domain: 'https://stock.clical.xin',
      message: null,
      tasks: [],
    }));
    const app = Fastify();
    registerAdminRoutes(app, {
      pool: {} as Pool,
      dbOnline: false,
      config: loadConfig(),
      envFilePath: '.env',
      publicAccess: {
        status: async () => ({ available: true, enabled: true, running: true, domain: 'https://stock.clical.xin', message: null, tasks: [] }),
        setEnabled,
      },
    });
    expect((await app.inject({ method: 'GET', url: '/api/admin/public-access' })).statusCode).toBe(401);
    const updated = await app.inject({
      method: 'PUT',
      url: '/api/admin/public-access',
      headers: { authorization: 'Bearer test-admin-token' },
      payload: { enabled: false },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().enabled).toBe(false);
    expect(setEnabled).toHaveBeenCalledWith(false);
    await app.close();
  });
});
