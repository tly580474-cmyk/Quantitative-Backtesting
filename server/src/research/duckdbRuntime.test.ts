import { access, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getDuckDBRuntimeStats, openManagedDuckDB } from './duckdbRuntime.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('managed DuckDB runtime', () => {
  it('isolates temporary directories and closing one session does not affect another', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duckdb-runtime-test-'));
    roots.push(root);
    const first = await openManagedDuckDB({ label: 'first', tempRoot: root,
      config: { threads: '1', max_memory: '16MB' } });
    const second = await openManagedDuckDB({ label: 'second', tempRoot: root,
      config: { threads: '1', max_memory: '16MB' } });
    try {
      expect(first.tempDirectory).not.toBe(second.tempDirectory);
      const setting = await second.connection.runAndReadAll(
        "SELECT current_setting('temp_directory') AS value",
      );
      expect(String(setting.getRowObjectsJson()[0]?.value).replaceAll('\\', '/'))
        .toBe(second.tempDirectory.replaceAll('\\', '/'));
      const spillSql = `CREATE TEMP TABLE payload AS
        SELECT i, repeat(md5(CAST(i AS VARCHAR)), 4) AS payload
        FROM range(500000) AS rows(i)`;
      await Promise.all([first.connection.run(spillSql), second.connection.run(spillSql)]);
      expect((await readdir(first.tempDirectory)).some((name) => name.startsWith('duckdb_temp_storage')))
        .toBe(true);
      expect((await readdir(second.tempDirectory)).some((name) => name.startsWith('duckdb_temp_storage')))
        .toBe(true);
      await first.close();
      await access(second.tempDirectory);
      const reader = await second.connection.runAndReadAll(
        'SELECT COUNT(*) AS total FROM payload',
      );
      expect(Number(reader.getRowObjectsJson()[0]?.total)).toBe(500_000);
    } finally {
      await first.close();
      await second.close();
    }
    expect(getDuckDBRuntimeStats()).toMatchObject({ active: 0, queued: 0 });
  });

  it('queues sessions above the configured global limit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duckdb-runtime-limit-'));
    roots.push(root);
    const previous = process.env.DUCKDB_MAX_CONCURRENT;
    process.env.DUCKDB_MAX_CONCURRENT = '1';
    const first = await openManagedDuckDB({ label: 'holder', tempRoot: root });
    try {
      let opened = false;
      const waiting = openManagedDuckDB({ label: 'waiting', tempRoot: root })
        .then((session) => { opened = true; return session; });
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
      expect(opened).toBe(false);
      expect(getDuckDBRuntimeStats()).toMatchObject({ active: 1, queued: 1, limit: 1 });
      await first.close();
      const second = await waiting;
      expect(opened).toBe(true);
      await second.close();
    } finally {
      await first.close();
      if (previous === undefined) delete process.env.DUCKDB_MAX_CONCURRENT;
      else process.env.DUCKDB_MAX_CONCURRENT = previous;
    }
  });
});
