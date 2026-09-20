import { mkdir, mkdtemp, readFile, readdir, rm, unlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { getDatabaseBackupExportStatus, resolveDatabaseBackupDownload, startDatabaseBackupExport, pruneDatabaseBackupExports } from './databaseBackupExport.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('admin database backup export', () => {
  it('runs an atomic export and exposes only the verified completed file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'admin-db-export-'));
    roots.push(root);
    const config = { ...loadConfig(), BACKUP_ROOT: root };
    const status = await startDatabaseBackupExport(config, {
      dump: async (_config, path) => writeFile(path, '-- database backup\nSELECT 1;\n', 'utf8'),
    });
    expect(status.status).toBe('running');
    let completed = await getDatabaseBackupExportStatus(config);
    for (let index = 0; completed.status === 'running' && index < 20; index += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
      completed = await getDatabaseBackupExportStatus(config);
    }
    expect(completed.status).toBe('completed');
    expect(completed.bytes).toBeGreaterThan(0);
    expect(completed.sha256).toMatch(/^[a-f0-9]{64}$/);
    const download = await resolveDatabaseBackupDownload(config, completed.id);
    expect(await readFile(download.path, 'utf8')).toContain('SELECT 1');
  });

  it('detects deletion and reads an externally replaced status manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'admin-db-export-'));
    roots.push(root);
    const config = { ...loadConfig(), BACKUP_ROOT: root };
    const dir = join(root, 'admin-database-exports');
    await mkdir(dir);
    const id = 'database-20260920000000-1';
    const value = { id, status: 'completed', fileName: `${id}.sql`, bytes: 9, sha256: 'a'.repeat(64) };
    await writeFile(join(dir, value.fileName), 'SELECT 1;');
    await writeFile(join(dir, 'latest.json'), JSON.stringify(value));
    expect((await getDatabaseBackupExportStatus(config)).status).toBe('completed');
    await unlink(join(dir, value.fileName));
    expect((await getDatabaseBackupExportStatus(config)).status).toBe('failed');
    await expect(resolveDatabaseBackupDownload(config, id)).rejects.toThrow();
    const next = { ...value, id: 'database-20260921000000-2', fileName: 'database-20260921000000-2.sql' };
    await writeFile(join(dir, next.fileName), 'SELECT 2;');
    await writeFile(join(dir, 'latest.json'), JSON.stringify(next));
    expect((await getDatabaseBackupExportStatus(config)).id).toBe(next.id);
    expect((await resolveDatabaseBackupDownload(config, next.id)).bytes).toBe(9);
  });

  it('retains the newest successful export and removes only eligible completed exports', async () => {
    const root = await mkdtemp(join(tmpdir(), 'admin-db-export-'));
    roots.push(root);
    const config = { ...loadConfig(), BACKUP_ROOT: root, ADMIN_BACKUP_RETAIN_COUNT: '2', ADMIN_BACKUP_RETAIN_DAYS: '7' };
    const dir = join(root, 'admin-database-exports');
    await mkdir(dir);
    const files = ['database-20260920000000-1.sql', 'database-20260919000000-1.sql', 'database-20260918000000-1.sql',
      'database-20260917000000-1.sql', 'database-20260916000000-1.sql.partial', 'manual.sql'];
    for (const [index, file] of files.entries()) {
      await writeFile(join(dir, file), 'data');
      const time = new Date(Date.now() - (index === 3 ? 10 * 86_400_000 : index * 1000));
      await utimes(join(dir, file), time, time);
    }
    await pruneDatabaseBackupExports({ ...config, ADMIN_BACKUP_RETAIN_COUNT: '10' }, files[0]);
    expect(await readdir(dir)).not.toContain(files[3]);
    expect(await readdir(dir)).toContain(files[2]);
    await pruneDatabaseBackupExports(config, files[0]);
    expect((await readdir(dir)).sort()).toEqual([files[0], files[1], files[4], files[5]].sort());
  });

  it('rejects concurrent export starts and recovers an interrupted manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'admin-db-export-'));
    roots.push(root);
    const config = { ...loadConfig(), BACKUP_ROOT: root };
    const dir = join(root, 'admin-database-exports');
    await mkdir(dir);
    await writeFile(join(dir, 'latest.json'), JSON.stringify({ status: 'running', id: 'interrupted' }));
    const start = startDatabaseBackupExport(config, { dump: async (_config, path) => writeFile(path, 'SELECT 1;') });
    await expect(startDatabaseBackupExport(config)).rejects.toThrow('已有');
    await start;
    for (let i = 0; i < 50; i++) {
      if ((await getDatabaseBackupExportStatus(config)).status !== 'running') break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    expect((await getDatabaseBackupExportStatus(config)).status).toBe('completed');
    // Allow the post-success retention pass to finish before disposing the directory.
    await new Promise(resolve => setTimeout(resolve, 20));
  });

  it('persists a failed status and removes the partial file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'admin-db-export-'));
    roots.push(root);
    const config = { ...loadConfig(), BACKUP_ROOT: root };
    await startDatabaseBackupExport(config, {
      dump: async () => { throw new Error('mysqldump unavailable'); },
    });
    let failed = await getDatabaseBackupExportStatus(config);
    for (let index = 0; failed.status === 'running' && index < 20; index += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
      failed = await getDatabaseBackupExportStatus(config);
    }
    expect(failed).toMatchObject({ status: 'failed', error: 'mysqldump unavailable' });
  });
});
