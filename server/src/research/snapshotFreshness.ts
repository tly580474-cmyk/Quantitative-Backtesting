import { resolve } from 'node:path';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { readCurrentSnapshot, type ResearchSnapshotManifest } from './snapshotManifest.js';

export type SnapshotFreshnessStatus = 'current' | 'stale' | 'inconsistent' | 'unavailable';

export interface SnapshotSourceState {
  rowCount: number;
  maxDate: string | null;
}

export interface SnapshotFreshnessReport {
  status: SnapshotFreshnessStatus;
  snapshot: {
    snapshotId: string | null;
    rowCount: number | null;
    maxDate: string | null;
  };
  mysql: SnapshotSourceState;
  message: string;
}

interface SnapshotSourceSummaryRow extends RowDataPacket {
  rowsCount: number | string;
  maxDate: string | null;
}

export async function getResearchSnapshotFreshness(
  pool: Pool,
  snapshotRootInput: string,
): Promise<SnapshotFreshnessReport> {
  const snapshotRoot = resolve(snapshotRootInput);
  const [rows] = await pool.query<SnapshotSourceSummaryRow[]>(`
    SELECT COUNT(*) AS rowsCount,
           DATE_FORMAT(MAX(trade_date), '%Y-%m-%d') AS maxDate
    FROM daily_bars_v2
  `);
  const source: SnapshotSourceState = {
    rowCount: Number(rows[0]?.rowsCount ?? 0),
    maxDate: rows[0]?.maxDate ?? null,
  };
  const current = await readCurrentSnapshot(snapshotRoot);
  return compareSnapshotFreshness(current?.manifest ?? null, source);
}

export function compareSnapshotFreshness(
  manifest: ResearchSnapshotManifest | null,
  source: SnapshotSourceState,
): SnapshotFreshnessReport {
  if (!manifest) {
    return {
      status: 'unavailable',
      snapshot: { snapshotId: null, rowCount: null, maxDate: null },
      mysql: source,
      message: '尚未发布可用的研究快照',
    };
  }

  const snapshot = {
    snapshotId: manifest.snapshotId,
    rowCount: manifest.rowCount,
    maxDate: manifest.maxDate,
  };
  if (manifest.rowCount === source.rowCount && manifest.maxDate === source.maxDate) {
    return {
      status: 'current',
      snapshot,
      mysql: source,
      message: '研究快照已追平 MySQL 权威库',
    };
  }

  if (
    source.maxDate
    && (manifest.maxDate > source.maxDate || manifest.rowCount > source.rowCount)
  ) {
    return {
      status: 'inconsistent',
      snapshot,
      mysql: source,
      message: '研究快照领先或不一致，请复核 MySQL 与快照来源',
    };
  }

  return {
    status: 'stale',
    snapshot,
    mysql: source,
    message: '研究快照落后于 MySQL 权威库，请先执行 snapshot:build 与 snapshot:verify',
  };
}

export async function assertResearchSnapshotFresh(
  pool: Pool,
  snapshotRoot: string,
): Promise<SnapshotFreshnessReport> {
  const report = await getResearchSnapshotFreshness(pool, snapshotRoot);
  if (report.status !== 'current') {
    throw new Error(
      `${report.message}（snapshot=${report.snapshot.maxDate ?? 'N/A'}/${report.snapshot.rowCount ?? 'N/A'}, `
      + `mysql=${report.mysql.maxDate ?? 'N/A'}/${report.mysql.rowCount}）`,
    );
  }
  return report;
}
