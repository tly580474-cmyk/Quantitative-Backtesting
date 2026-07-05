import { join, resolve } from 'node:path';
import { stat } from 'node:fs/promises';
import { DuckDBInstance } from '@duckdb/node-api';
import { readCurrentSnapshot, sha256File } from './snapshotManifest.js';

export async function verifyCurrentResearchSnapshot(root: string) {
  const snapshotRoot = resolve(root);
  const current = await readCurrentSnapshot(snapshotRoot);
  if (!current) throw new Error('尚未发布可用的研究快照');
  let verifiedRows = 0;
  const files = [];
  const instance = await DuckDBInstance.create(':memory:', { threads: '4' });
  const connection = await instance.connect();
  try {
    for (const partition of current.manifest.partitions) {
      const path = join(
        snapshotRoot,
        current.manifest.snapshotId,
        partition.relativePath,
      );
      const [fileStat, checksum] = await Promise.all([
        stat(path),
        sha256File(path),
      ]);
      if (fileStat.size !== partition.bytes) {
        throw new Error(`${partition.relativePath} 文件大小不一致`);
      }
      if (checksum !== partition.sha256) {
        throw new Error(`${partition.relativePath} SHA-256 不一致`);
      }
      const reader = await connection.runAndReadAll(`
        SELECT COUNT(*) AS rows
        FROM read_parquet('${escapeSqlPath(path)}')
      `);
      const rows = Number(
        (reader.getRowObjectsJson()[0] as Record<string, unknown> | undefined)?.rows ?? 0,
      );
      if (rows !== partition.rows) {
        throw new Error(`${partition.relativePath} 行数不一致`);
      }
      verifiedRows += rows;
      files.push({
        relativePath: partition.relativePath,
        rows,
        bytes: fileStat.size,
        sha256: checksum,
      });
    }
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
  if (verifiedRows !== current.manifest.rowCount) {
    throw new Error('研究快照总行数不一致');
  }
  return {
    status: 'validated' as const,
    snapshotId: current.manifest.snapshotId,
    rowCount: verifiedRows,
    files,
  };
}

function escapeSqlPath(path: string): string {
  return resolve(path).replaceAll('\\', '/').replaceAll("'", "''");
}
