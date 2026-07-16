import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openManagedDuckDB } from './duckdbRuntime.js';
import { exportSqlScript, supportsDirectDuckDBExport } from './duckdbExport.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('DuckDB direct export', () => {
  it('exports a parameterized multi-statement script to CSV without materializing rows', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duckdb-export-csv-'));
    roots.push(root);
    const session = await openManagedDuckDB({ label: 'export-csv', tempRoot: root });
    try {
      const path = join(root, 'result.csv');
      const result = await exportSqlScript(
        session.connection,
        'CREATE TEMP TABLE sample AS SELECT * FROM range(5) rows(id); SELECT id FROM sample WHERE id >= $min ORDER BY id',
        { min: 2 },
        path,
        'csv',
      );
      expect(result.rows).toBe(3);
      expect(await readFile(path, 'utf8')).toBe('id\n2\n3\n4\n');
    } finally {
      await session.close();
    }
  });

  it('exports Parquet with ZSTD compression', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duckdb-export-parquet-'));
    roots.push(root);
    const session = await openManagedDuckDB({ label: 'export-parquet', tempRoot: root });
    try {
      const path = join(root, 'result.parquet');
      const result = await exportSqlScript(
        session.connection,
        'SELECT i, repeat(\'x\', 20) AS payload FROM range(100) rows(i)',
        {},
        path,
        'parquet',
      );
      expect(result.rows).toBe(100);
      expect((await stat(path)).size).toBeGreaterThan(0);
      const reader = await session.connection.runAndReadAll(
        `SELECT COUNT(*) AS rows FROM read_parquet('${path.replaceAll('\\', '/')}')`,
      );
      expect(Number(reader.getRowObjectsJson()[0]?.rows)).toBe(100);
    } finally {
      await session.close();
    }
  });

  it('only selects COPY for CSV and Parquet file outputs', () => {
    expect(supportsDirectDuckDBExport('result.csv', 'table')).toBe(true);
    expect(supportsDirectDuckDBExport('result.parquet', 'table')).toBe(true);
    expect(supportsDirectDuckDBExport('result.json', 'table')).toBe(false);
  });

  it('exports partitioned Parquet directories without collecting result rows in Node.js', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duckdb-export-partitioned-'));
    roots.push(root);
    const session = await openManagedDuckDB({ label: 'export-partitioned', tempRoot: root });
    try {
      const path = join(root, 'partitioned');
      await exportSqlScript(
        session.connection,
        'SELECT i % 2 AS bucket, i AS value FROM range(10) rows(i)',
        {},
        path,
        'parquet',
        false,
        false,
        ['bucket'],
      );
      const reader = await session.connection.runAndReadAll(
        `SELECT COUNT(*) AS rows FROM read_parquet('${path.replaceAll('\\', '/')}/**/*.parquet', hive_partitioning=true)`,
      );
      expect(Number(reader.getRowObjectsJson()[0]?.rows)).toBe(10);
    } finally {
      await session.close();
    }
  });
});
