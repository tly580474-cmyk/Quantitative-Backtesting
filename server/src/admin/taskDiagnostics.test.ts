// @vitest-environment node
// SQL semantics exercised against an isolated in-memory database; no market data is accessed.
import type { Pool } from 'mysql2/promise';
import { expect, it } from 'vitest';
import { inspectTasks } from './diagnostics.js';

const sqlite = await import('node:sqlite').catch(() => null);
it.skipIf(!sqlite)('counts only recent failures without a strictly later successful run of the same key', async () => {
  const db = new sqlite!.DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE sync_jobs (status TEXT, run_key TEXT, created_at TEXT);
      CREATE INDEX idx_sj_status_created ON sync_jobs(status, created_at);
      CREATE INDEX idx_sj_run_key ON sync_jobs(status, run_key, created_at);
      CREATE TABLE factor_mining_tasks (status TEXT, deleted_at TEXT, archived_at TEXT, created_at TEXT);`);
    const recent = new Date(Date.now() - 60_000).toISOString();
    const later = new Date().toISOString();
    const older = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const insert = db.prepare('INSERT INTO sync_jobs VALUES (?, ?, ?)');
    for (const key of ['recovered', 'equal', 'old-success', 'no-success', '', null]) insert.run('failed', key, recent);
    insert.run('failed', 'outside-window', older);
    insert.run('completed', 'recovered', later);
    insert.run('completed', 'equal', recent);
    insert.run('completed', 'old-success', older);
    insert.run('completed', '', later);
    insert.run('completed', null, later);
    const mining = db.prepare('INSERT INTO factor_mining_tasks VALUES (?, ?, ?, ?)');
    mining.run('failed', null, null, recent);
    mining.run('failed', recent, null, recent);
    mining.run('failed', null, recent, recent);
    const pool = { query: async (sql: string, parameters: string[] = []) => [db.prepare(sql).all(...parameters)] } as unknown as Pool;
    const result = await inspectTasks(pool, true);
    expect(result.summary.recentFailures).toEqual({ syncJobs: 5, miningTasks: 1 });
    expect(result.checks[0].summary).toContain('6 个失败任务');
  } finally { db.close(); }
});
