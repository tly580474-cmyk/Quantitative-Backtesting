import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'mysql2/promise';
import { loadConfig } from '../config.js';
import { registerAdminRoutes } from './admin.js';

const previousToken = process.env.ADMIN_API_TOKEN;

afterEach(() => {
  vi.useRealTimers();
  if (previousToken === undefined) delete process.env.ADMIN_API_TOKEN;
  else process.env.ADMIN_API_TOKEN = previousToken;
});

describe('admin routes', () => {
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

  it('exposes minute-lake and daily K-line progress only to authenticated admins', async () => {
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
    expect(accepted.json().items.map((item: { key: string }) => item.key)).toEqual(['minute_lake', 'daily_kline']);
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
});
