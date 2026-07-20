import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { getDatabaseBackupExportStatus, resolveDatabaseBackupDownload, startDatabaseBackupExport } from './databaseBackupExport.js';

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
