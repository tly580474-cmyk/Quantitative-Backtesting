import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DuckDBInstance } from '@duckdb/node-api';
import { afterEach, describe, it } from 'vitest';
import { buildResearchQuery, queryResearchSnapshot } from './duckdbResearchService.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })));
});

describe('DuckDB research query builder', () => {
  it('projects only whitelisted fields and parameterizes filters', () => {
    const result = buildResearchQuery('D:/snapshots/year=*/data.parquet', {
      startDate: '2025-01-01',
      endDate: '2025-12-31',
      fields: ['symbol', 'tradeDate', 'close'],
      markets: ['SH', 'SZ'],
      symbols: ['000001'],
      limit: 100,
    });
    assert.deepEqual(result.fields, ['symbol', 'tradeDate', 'close']);
    assert.match(result.sql, /market IN \(\$market0, \$market1\)/);
    assert.match(result.sql, /symbol IN \(\$symbol0\)/);
    assert.equal(result.values.symbol0, '000001');
  });

  it('rejects unknown projection fields', () => {
    assert.throws(() => buildResearchQuery('data.parquet', {
      startDate: '2025-01-01',
      endDate: '2025-12-31',
      fields: ['drop table daily_bars_v2'],
      limit: 10,
    }), /不支持的研究字段/);
  });

  it('queries a published Parquet snapshot through DuckDB', async () => {
    const root = await mkdtemp(join(tmpdir(), 'research-snapshot-'));
    temporaryRoots.push(root);
    const snapshotId = 'snapshot-test';
    const partitionDir = join(root, snapshotId, 'bars', 'year=2026');
    await mkdir(partitionDir, { recursive: true });
    const parquetPath = join(partitionDir, 'data.parquet').replaceAll('\\', '/');
    const instance = await DuckDBInstance.create(':memory:');
    const connection = await instance.connect();
    await connection.run(`
      COPY (
        SELECT 1::BIGINT AS instrumentKey,
               'SZ'::VARCHAR AS market,
               '000001'::VARCHAR AS symbol,
               '平安银行'::VARCHAR AS name,
               '银行'::VARCHAR AS industry,
               DATE '2026-07-03' AS tradeDate,
               10.0::DOUBLE AS open,
               11.0::DOUBLE AS high,
               9.0::DOUBLE AS low,
               10.5::DOUBLE AS close,
               10.0::DOUBLE AS previousClose,
               100::BIGINT AS volume,
               1000.0::DOUBLE AS amount,
               1.0::DOUBLE AS turnoverRatePct,
               NULL::DOUBLE AS totalMarketCap,
               NULL::DOUBLE AS floatMarketCap,
               NULL::DOUBLE AS peTtm,
               NULL::DOUBLE AS pb,
               NULL::DOUBLE AS psTtm,
               NULL::DOUBLE AS volumeRatio
      ) TO '${parquetPath}' (FORMAT parquet)
    `);
    connection.closeSync();
    instance.closeSync();
    await writeFile(join(root, 'current.json'), JSON.stringify({
      snapshotId,
      publishedAt: '2026-07-05T00:00:00.000Z',
    }));
    await writeFile(join(root, snapshotId, 'manifest.json'), JSON.stringify({
      schemaVersion: 1,
      snapshotId,
      sourceVersion: 'batch-test',
      sourcePublishedAt: null,
      createdAt: '2026-07-05T00:00:00.000Z',
      status: 'validated',
      rowCount: 1,
      instrumentCount: 1,
      minDate: '2026-07-03',
      maxDate: '2026-07-03',
      partitions: [{
        year: 2026,
        relativePath: 'bars/year=2026/data.parquet',
        rows: 1,
        bytes: 1,
        minDate: '2026-07-03',
        maxDate: '2026-07-03',
        sha256: 'test',
      }],
    }));

    const result = await queryResearchSnapshot(root, {
      startDate: '2026-07-03',
      endDate: '2026-07-03',
      fields: ['symbol', 'tradeDate', 'close'],
      markets: ['SZ'],
      limit: 10,
    });
    assert.equal(result.items.length, 1);
    assert.deepEqual(result.items[0], {
      symbol: '000001',
      tradeDate: '2026-07-03',
      close: 10.5,
    });
  });
});
