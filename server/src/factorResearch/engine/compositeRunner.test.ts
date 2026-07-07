import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { describe, expect, it } from 'vitest';
import { sha256File, type ResearchSnapshotManifest } from '../../research/snapshotManifest.js';
import { runCompositeFactorResearch } from './compositeRunner.js';

describe('composite factor runner', () => {
  it('evaluates correlation and equal-weight composite layers from a published snapshot', async () => {
    const root = await createFixtureSnapshot();

    const report = await runCompositeFactorResearch({
      snapshotRoot: root,
      config: {
        factorIds: ['momentum_20', 'reversal_5'],
        startDate: '2026-01-25',
        endDate: '2026-02-08',
        validationStartDate: '2026-02-01',
        horizonDays: 2,
        layers: 3,
        weighting: 'equal',
      },
      writeReport: false,
    });

    expect(report.snapshotId).toBe('composite-snapshot-test');
    expect(report.summary.factorCount).toBe(2);
    expect(report.weights).toHaveLength(2);
    expect(report.weights.every((item) => item.source === 'equal')).toBe(true);
    expect(report.summary.sampleCount).toBeGreaterThan(0);
    expect(report.correlations).toHaveLength(3);
    expect(report.correlations.find((item) => item.factorA !== item.factorB)?.sampleCount)
      .toBe(report.summary.sampleCount);
    expect(report.layers).toHaveLength(3);
    expect(report.sampleSplit?.train.tradingDays).toBeGreaterThan(0);
    expect(report.sampleSplit?.validation.tradingDays).toBeGreaterThan(0);
    expect(report.sampleSplit?.validation.longShortSpread).not.toBeNull();
  });

  it('learns IC weights from the training segment', async () => {
    const root = await createFixtureSnapshot();

    const report = await runCompositeFactorResearch({
      snapshotRoot: root,
      config: {
        factorIds: ['momentum_20', 'reversal_5'],
        startDate: '2026-01-25',
        endDate: '2026-02-08',
        validationStartDate: '2026-02-01',
        horizonDays: 2,
        layers: 3,
        weighting: 'ic',
      },
      writeReport: false,
    });

    expect(report.weights).toHaveLength(2);
    expect(report.weights.every((item) => item.source === 'ic')).toBe(true);
    expect(report.weights.reduce((sum, item) => sum + Math.abs(item.weight), 0))
      .toBeCloseTo(1);
    expect(report.weights.some((item) => item.trainingIc !== null)).toBe(true);
  });

  it('normalizes manual weights', async () => {
    const root = await createFixtureSnapshot();

    const report = await runCompositeFactorResearch({
      snapshotRoot: root,
      config: {
        factorIds: ['momentum_20', 'reversal_5'],
        startDate: '2026-01-25',
        endDate: '2026-02-08',
        horizonDays: 2,
        layers: 3,
        weighting: 'manual',
        manualWeights: { momentum_20: 2, reversal_5: -1 },
      },
      writeReport: false,
    });

    expect(report.weights.map((item) => item.weight)).toEqual([
      expect.closeTo(2 / 3),
      expect.closeTo(-1 / 3),
    ]);
    expect(report.weights.every((item) => item.source === 'manual')).toBe(true);
  });

  it('requires at least two factors', async () => {
    const root = await createFixtureSnapshot();

    await expect(runCompositeFactorResearch({
      snapshotRoot: root,
      config: {
        factorIds: ['momentum_20'],
        startDate: '2026-01-25',
        endDate: '2026-02-08',
        horizonDays: 2,
        layers: 3,
        weighting: 'equal',
      },
      writeReport: false,
    })).rejects.toThrow('2～12 个因子');
  });

  it('requires validation start to be inside the research range', async () => {
    const root = await createFixtureSnapshot();

    await expect(runCompositeFactorResearch({
      snapshotRoot: root,
      config: {
        factorIds: ['momentum_20', 'reversal_5'],
        startDate: '2026-01-25',
        endDate: '2026-02-08',
        validationStartDate: '2026-01-25',
        horizonDays: 2,
        layers: 3,
        weighting: 'equal',
      },
      writeReport: false,
    })).rejects.toThrow('验证区间开始日期');
  });

  it('requires manual weights for every factor', async () => {
    const root = await createFixtureSnapshot();

    await expect(runCompositeFactorResearch({
      snapshotRoot: root,
      config: {
        factorIds: ['momentum_20', 'reversal_5'],
        startDate: '2026-01-25',
        endDate: '2026-02-08',
        horizonDays: 2,
        layers: 3,
        weighting: 'manual',
        manualWeights: { momentum_20: 1 },
      },
      writeReport: false,
    })).rejects.toThrow('手动权重缺少因子');
  });
});

async function createFixtureSnapshot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'composite-snapshot-'));
  const snapshotId = 'composite-snapshot-test';
  const partitionDir = join(root, snapshotId, 'bars', 'year=2026');
  await mkdir(partitionDir, { recursive: true });
  const parquetPath = join(partitionDir, 'data.parquet');
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  try {
    await connection.run(`
      CREATE TABLE bars AS
      SELECT instrumentKey,
             market,
             symbol,
             name,
             industry,
             CAST(DATE '2026-01-01' + CAST(day AS INTEGER) AS DATE) AS tradeDate,
             close * 0.995 AS open,
             close * 1.01 AS high,
             close * 0.99 AS low,
             close,
             close * 0.99 AS previousClose,
             CAST(1000000 + day * 1000 + instrumentKey AS BIGINT) AS volume,
             CAST(100000000 + day * 10000 + instrumentKey AS DOUBLE) AS amount,
             CAST(1 + instrumentKey * 0.1 AS DOUBLE) AS turnoverRatePct,
             CAST(1000000000 + instrumentKey * 1000000 AS DOUBLE) AS totalMarketCap,
             CAST(800000000 + instrumentKey * 1000000 AS DOUBLE) AS floatMarketCap,
             CAST(10 + instrumentKey AS DOUBLE) AS peTtm,
             CAST(1 + instrumentKey / 10 AS DOUBLE) AS pb,
             CAST(2 + instrumentKey / 10 AS DOUBLE) AS psTtm,
             CAST(1 + day / 100 AS DOUBLE) AS volumeRatio
      FROM range(0, 45) AS days(day)
      CROSS JOIN (
        SELECT *
        FROM (VALUES
          (1, 'SH', '600001', 'A', 'Tech', 0.10),
          (2, 'SH', '600002', 'B', 'Tech', 0.05),
          (3, 'SZ', '000001', 'C', 'Bank', -0.02),
          (4, 'SZ', '000002', 'D', 'Bank', 0.01)
        ) AS instruments(instrumentKey, market, symbol, name, industry, slope)
      )
      CROSS JOIN LATERAL (
        SELECT CAST(10 + instrumentKey + day * slope AS DOUBLE) AS close
      )
    `);
    await connection.run(`
      COPY bars TO '${parquetPath.replaceAll('\\', '/').replaceAll("'", "''")}'
      (FORMAT parquet, COMPRESSION zstd)
    `);
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
  const fileStat = await stat(parquetPath);
  const manifest: ResearchSnapshotManifest = {
    schemaVersion: 1,
    snapshotId,
    sourceVersion: 'fixture-source',
    sourcePublishedAt: '2026-02-14T00:00:00.000Z',
    createdAt: '2026-02-14T00:00:00.000Z',
    status: 'validated',
    rowCount: 180,
    instrumentCount: 4,
    minDate: '2026-01-01',
    maxDate: '2026-02-14',
    partitions: [{
      year: 2026,
      relativePath: 'bars/year=2026/data.parquet',
      rows: 180,
      bytes: fileStat.size,
      minDate: '2026-01-01',
      maxDate: '2026-02-14',
      sha256: await sha256File(parquetPath),
    }],
  };
  await writeFile(join(root, snapshotId, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await writeFile(join(root, 'current.json'), `${JSON.stringify({
    snapshotId,
    publishedAt: '2026-02-14T00:00:00.000Z',
  }, null, 2)}\n`, 'utf8');
  return root;
}
