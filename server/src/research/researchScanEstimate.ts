import { readdir, stat } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import type { ResearchSnapshotManifest } from './snapshotManifest.js';

export interface ResearchScanEstimate {
  scope: string;
  files: number;
  rows: number | null;
  bytes: number;
  note: string;
}

const DATASET_VIEWS: Record<string, string[]> = {
  adjustment_factors: ['adjustment_factors', 'stock_prices_qfq'],
  index_bars: ['index_bars', 'official_index_prices'],
  index_constituent_snapshots: ['index_constituent_snapshots', 'index_membership_snapshots', 'index_weight_snapshots'],
  index_constituents: ['index_constituents', 'index_constituents_scd', 'index_constituents_effective', 'index_weights_scd'],
  dividend_events: ['dividend_events'],
  sw_industry_definitions: ['sw_industry_definitions'],
  sw_industry_memberships: ['sw_industry_memberships', 'sw_industry_current'],
  sw_industry_bars: ['sw_industry_bars'],
};

export function estimateSnapshotScan(
  sql: string,
  manifest: ResearchSnapshotManifest,
): ResearchScanEstimate {
  const lower = sql.toLowerCase();
  const usesBars = /\b(bars|stock_valuations|stock_prices_qfq|trading_calendar)\b/.test(lower);
  const selectedDatasets = (manifest.datasets ?? []).filter((dataset) =>
    (DATASET_VIEWS[dataset.name] ?? [dataset.name]).some((view) =>
      new RegExp(`\\b${escapeRegExp(view.toLowerCase())}\\b`).test(lower),
    ),
  );
  let files = 0;
  let rows = 0;
  let bytes = 0;
  const scopes: string[] = [];
  if (usesBars) {
    files += manifest.partitions.length;
    rows += manifest.rowCount;
    bytes += manifest.partitions.reduce((sum, item) => sum + item.bytes, 0);
    scopes.push('bars');
  }
  for (const dataset of selectedDatasets) {
    files += 1;
    rows += dataset.rows;
    bytes += dataset.bytes;
    scopes.push(dataset.name);
  }
  return {
    scope: scopes.length > 0 ? scopes.join(',') : 'unknown/custom SQL',
    files,
    rows: scopes.length > 0 ? rows : null,
    bytes,
    note: scopes.length > 0
      ? '按 manifest 统计候选文件上界；DuckDB 谓词下推后的实际扫描量可能更小。'
      : 'SQL 未引用已知快照视图，无法从 manifest 可靠估算。',
  };
}

export async function estimateMinutePatterns(patterns: string[]): Promise<ResearchScanEstimate> {
  let files = 0;
  let bytes = 0;
  for (const pattern of patterns) {
    const directory = dirname(pattern);
    const matcher = wildcardMatcher(basename(pattern));
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !matcher.test(entry.name)) continue;
      files += 1;
      bytes += (await stat(`${directory}/${entry.name}`)).size;
    }
  }
  return {
    scope: 'minute parquet patterns',
    files,
    rows: null,
    bytes,
    note: '分钟 Parquet 未在 manifest 中记录逐文件行数，行数将在 COPY 完成后写入产物 manifest。',
  };
}

export function formatScanEstimate(estimate: ResearchScanEstimate): string {
  const rows = estimate.rows === null ? 'unknown' : estimate.rows.toLocaleString('en-US');
  return `扫描预估：scope=${estimate.scope}; files=${estimate.files}; rows=${rows}; bytes=${formatBytes(estimate.bytes)}。${estimate.note}`;
}

function wildcardMatcher(pattern: string): RegExp {
  return new RegExp(`^${escapeRegExp(pattern).replaceAll('\\*', '.*').replaceAll('\\?', '.')}$`, 'i');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** index).toFixed(index >= 3 ? 1 : 0)} ${units[index]}`;
}
