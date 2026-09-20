import Fastify from 'fastify';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'mysql2/promise';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config.js';
import { registerAdminRoutes } from './admin.js';
import { ADMIN_CONFIG_DEFINITIONS } from '../admin/envConfig.js';

vi.mock('../db/index.js', async importOriginal => ({
  ...await importOriginal<typeof import('../db/index.js')>(), initDb: vi.fn(),
}));
vi.mock('../admin/diagnostics.js', () => ({
  collectAdminHealth: vi.fn(async ({ dbOnline }) => ({ database: { online: dbOnline } })),
  collectAdminOverview: vi.fn(async ({ dbOnline }) => ({ database: { online: dbOnline } })),
}));
vi.mock('../admin/scheduleConfig.js', () => ({
  synchronizeScheduleConfig: vi.fn(async () => ({ updatedTasks: [], warnings: [] })),
}));

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
const headers = { authorization: 'Bearer test-admin-token' };
async function setup(pool = {} as Pool) {
  const root = await mkdtemp(join(tmpdir(), 'admin-resilience-'));
  roots.push(root);
  const app = Fastify();
  const config = { ...loadConfig(), ADMIN_API_TOKEN: 'test-admin-token', BACKUP_ROOT: root };
  const envFilePath = join(root, '.env');
  registerAdminRoutes(app, { pool, dbOnline: false, config, envFilePath });
  return { app, root, envFilePath };
}

describe('admin resilience', () => {
  it('limits failures across routes and ignores spoofed forwarding headers', async () => {
    vi.useFakeTimers();
    const { app } = await setup();
    try {
      for (let i = 0; i < 9; i++) {
        expect((await app.inject({ method: 'POST', url: '/api/admin/auth/verify',
          headers: { 'x-forwarded-for': `10.0.0.${i}` } })).statusCode).toBe(401);
      }
      const blocked = await app.inject({ url: '/api/admin/config' });
      expect(blocked.statusCode).toBe(429);
      expect(blocked.headers['retry-after']).toBe('60');
      expect((await app.inject({ url: '/api/admin/config', headers })).statusCode).toBe(429);
      expect((await app.inject({ url: '/api/admin/config', headers, remoteAddress: '192.0.2.2' })).statusCode).toBe(200);
      await vi.advanceTimersByTimeAsync(60_000);
      expect((await app.inject({ url: '/api/admin/config', headers })).statusCode).toBe(200);
    } finally { await app.close(); }
  });

  it('re-probes offline, recovered, and disconnected databases, sharing concurrent probes', async () => {
    vi.useFakeTimers();
    const ping = vi.fn().mockRejectedValue(new Error('offline'));
    const release = vi.fn();
    const getConnection = vi.fn(async () => ({ ping, release }));
    const { app } = await setup({ getConnection } as unknown as Pool);
    try {
      const read = () => app.inject({ url: '/api/admin/health', headers });
      const results = await Promise.all([read(), read(), read()]);
      expect(results.every(result => !result.json().database.online)).toBe(true);
      expect(getConnection).toHaveBeenCalledTimes(1);
      expect(release).toHaveBeenCalledTimes(1);
      ping.mockResolvedValue(undefined);
      await vi.advanceTimersByTimeAsync(5_001);
      expect((await read()).json().database.online).toBe(true);
      ping.mockRejectedValue(new Error('disconnected'));
      await vi.advanceTimersByTimeAsync(5_001);
      expect((await read()).json().database.online).toBe(false);
      expect(release).toHaveBeenCalledTimes(3);
    } finally { await app.close(); }
  });

  it('uses configuration metadata and blocks embedded admin credentials before writing', async () => {
    const { app, envFilePath } = await setup();
    vi.stubEnv('TINYSHARE_TOKEN', 'old');
    try {
      for (const candidate of [' test-admin-token ', 'prefix-test-admin-token-suffix']) {
        const response = await app.inject({ method: 'PUT', url: '/api/admin/config', headers,
          payload: { updates: { TINYSHARE_TOKEN: candidate } } });
        expect(response.statusCode).toBe(400);
        await expect(readFile(envFilePath)).rejects.toMatchObject({ code: 'ENOENT' });
      }
      const response = await app.inject({ method: 'PUT', url: '/api/admin/config', headers,
        payload: { updates: { TINYSHARE_TOKEN: 'business-key' } } });
      expect(response.json().restartRequired).toBe(ADMIN_CONFIG_DEFINITIONS.find(item => item.key === 'TINYSHARE_TOKEN')!.restartRequired);
      expect((await app.inject({ url: '/api/admin/config', headers })).json().items.find((item: { key: string }) => item.key === 'TINYSHARE_TOKEN').maskedValue).toBe('••••-key');
    } finally { await app.close(); }
  });

  it('streams native downloads with expiring, file-bound, single-use tickets', async () => {
    const { app, root } = await setup();
    const id = 'database-20260920000000-123';
    const dir = join(root, 'admin-database-exports');
    await mkdir(dir);
    await writeFile(join(dir, `${id}.sql`), 'SELECT 1;');
    await writeFile(join(dir, 'latest.json'), JSON.stringify({ id, status: 'completed', fileName: `${id}.sql`, bytes: 9, sha256: 'a'.repeat(64) }));
    try {
      const issue = () => app.inject({ method: 'POST', url: `/api/admin/database-backup/${id}/download-ticket`, headers });
      expect((await app.inject({ method: 'POST', url: `/api/admin/database-backup/${id}/download-ticket` })).statusCode).toBe(401);
      const response = await issue();
      expect(response.headers['cache-control']).toBe('no-store');
      const ticket = response.json().ticket;
      const download = (ticketValue: string, target = id) => app.inject({ method: 'POST', url: `/api/admin/database-backup/${target}/download`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: `ticket=${ticketValue}` });
      expect((await download(ticket, 'other')).statusCode).toBe(401);
      const file = await download(ticket);
      expect(file.statusCode).toBe(200);
      expect(file.body).toBe('SELECT 1;');
      expect(file.headers['content-disposition']).toContain(`${id}.sql`);
      expect((await download(ticket)).statusCode).toBe(401);
      const expired = (await issue()).json().ticket;
      const future = Date.now() + 60_001;
      vi.spyOn(Date, 'now').mockReturnValue(future);
      expect((await download(expired)).statusCode).toBe(401);
    } finally { await app.close(); }
  });
});
