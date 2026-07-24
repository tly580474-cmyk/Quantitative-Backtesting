import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DuckDBInstance } from '@duckdb/node-api';
import { afterEach, describe, it } from 'vitest';
import {
  buildMinuteQuery,
  getMinuteDataCatalog,
  normalizeMinuteProviderSymbol,
  queryMinuteBars,
} from './minuteDataService.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('minute data service', () => {
  it('normalizes provider symbols and parameterizes the stock filter', () => {
    assert.equal(normalizeMinuteProviderSymbol('600519'), '600519.SH');
    assert.equal(normalizeMinuteProviderSymbol('sz000001'), '000001.SZ');
    assert.equal(normalizeMinuteProviderSymbol('920992.BJ'), '920992.BJ');
    assert.equal(normalizeMinuteProviderSymbol('920992'), '920992.BJ');
    assert.equal(normalizeMinuteProviderSymbol('900901'), '900901.SH');
    const built = buildMinuteQuery(['D:/minute/year=2024/20240102.parquet'], {
      code: '600519',
      startDate: '2024-01-02',
      endDate: '2024-01-02',
      limit: 241,
      includeZeroVolume: true,
    });
    assert.match(built.sql, /code = \$providerSymbol/);
    assert.equal(built.values.providerSymbol, '600519.SH');
  });

  it('pushes supported minute aggregation into DuckDB without crossing the lunch break', () => {
    const built = buildMinuteQuery(['D:/minute/year=2024/20240102.parquet'], {
      code: '600519',
      startDate: '2024-01-02',
      endDate: '2024-01-02',
      intervalMinutes: 120,
      limit: 100,
      includeZeroVolume: true,
    });
    assert.match(built.sql, /FLOOR\(minute_index \/ 120\)/);
    assert.match(built.sql, /PARTITION BY CAST\(trade_time AS DATE\), session_name/);
    assert.doesNotMatch(built.sql, /<> '09:30'/);
  });

  it('reports an unavailable catalog when the manifest is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'minute-missing-'));
    roots.push(root);
    assert.deepEqual(await getMinuteDataCatalog(root), { status: 'unavailable' });
  });

  it('queries one stock from the prepared Parquet lake', async () => {
    const root = await mkdtemp(join(tmpdir(), 'minute-data-'));
    roots.push(root);
    const partition = join(root, 'year=2024');
    await mkdir(partition, { recursive: true });
    const parquetPath = join(partition, '20240102.parquet').replaceAll('\\', '/');
    const instance = await DuckDBInstance.create(':memory:');
    const connection = await instance.connect();
    await connection.run(`
      COPY (
        SELECT '600519.SH'::VARCHAR AS code,
               CAST(TIMESTAMP '2024-01-02 09:30:00' + i * INTERVAL 1 MINUTE AS VARCHAR) AS trade_time,
               (1700.0 + i)::FLOAT AS close,
               (1699.0 + i)::FLOAT AS open,
               (1701.0 + i)::FLOAT AS high,
               (1698.0 + i)::FLOAT AS low,
               100.0::FLOAT AS vol,
               170000.0::FLOAT AS amount,
               '20240102'::VARCHAR AS date,
               NULL::FLOAT AS pre_close,
               NULL::FLOAT AS change,
               NULL::FLOAT AS pct_chg,
               i::BIGINT AS __index_level_0__
        FROM range(10) AS minute_rows(i)
      ) TO '${parquetPath}' (FORMAT parquet)
    `);
    connection.closeSync();
    instance.closeSync();
    await writeFile(join(root, 'manifest.json'), JSON.stringify({
      schemaVersion: 1,
      dataset: 'a-share-1m-price',
      startYear: 2024,
      endYear: 2024,
      preparedAt: '2026-07-15T00:00:00.000Z',
      columns: ['code', 'trade_time'],
      years: [{
        year: 2024,
        sourceZip: '2024.zip',
        sourceBytes: 1,
        sourceModifiedAt: '2026-07-15T00:00:00.000Z',
        fileCount: 1,
        firstDate: '2024-01-02',
        lastDate: '2024-01-02',
        parquetBytes: 1,
        extractedFiles: 1,
      }],
      files: [{
        date: '2024-01-02',
        relativePath: 'year=2024/20240102.parquet',
        bytes: 1,
        crc32: '1234abcd',
      }],
    }));

    const result = await queryMinuteBars(root, {
      code: '600519',
      startDate: '2024-01-02',
      endDate: '2024-01-02',
      limit: 241,
      includeZeroVolume: true,
    });
    assert.equal(result.sourceFiles, 1);
    assert.equal(result.items.length, 10);
    assert.deepEqual(result.items[0], {
      date: '2024-01-02 09:30:00',
      open: 1699,
      high: 1701,
      low: 1698,
      close: 1700,
      volume: 100,
      amount: 170000,
      previousClose: null,
      change: null,
      changePct: null,
      isTradable: true,
    });

    const fiveMinute = await queryMinuteBars(root, {
      code: '600519',
      startDate: '2024-01-02',
      endDate: '2024-01-02',
      intervalMinutes: 5,
      limit: 241,
      includeZeroVolume: true,
    });
    assert.equal(fiveMinute.intervalMinutes, 5);
    assert.equal(fiveMinute.items.length, 2);
    assert.deepEqual(fiveMinute.items[0], {
      date: '2024-01-02 09:30:00',
      open: 1699,
      high: 1705,
      low: 1698,
      close: 1704,
      volume: 500,
      amount: 850000,
      previousClose: null,
      change: null,
      changePct: null,
      isTradable: true,
    });
  });
});
