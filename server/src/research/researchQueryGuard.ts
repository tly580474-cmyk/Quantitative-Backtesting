import type { ParameterMap } from './duckdbCliSupport.js';
import type { ResearchSnapshotManifest } from './snapshotManifest.js';

export function assertManagedParquetAccess(
  sql: string,
  params: ParameterMap,
  allowUnmanagedGlob: boolean,
): void {
  const wildcardRead = [...sql.matchAll(/read_parquet\s*\(([\s\S]*?)\)/gi)]
    .some((match) => {
      const argument = match[1];
      const literalGlob = [...argument.matchAll(/(['"])(.*?)\1/g)]
        .some((literal) => hasGlob(literal[2]));
      const parameterGlob = [...argument.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)\b/g)]
        .some((parameter) => typeof params[parameter[1]] === 'string'
          && hasGlob(String(params[parameter[1]])));
      return literalGlob || parameterGlob;
    });
  if (wildcardRead && !allowUnmanagedGlob) {
    throw new Error(
      'SQL 包含不受发布 manifest 约束的 read_parquet 通配符。'
      + '请改用已注册视图/正式 minute 命令；确需读取外部数据时显式添加 '
      + '--allow-unmanaged-parquet-glob，产物 manifest 会保留 SQL 校验和。',
    );
  }
}

function hasGlob(value: string): boolean {
  return /[*?]|\[[^\]]+\]/.test(value);
}

export function assertTemporalCoverage(
  sql: string,
  params: ParameterMap,
  manifest: ResearchSnapshotManifest | null,
): void {
  if (!manifest || !/\bsw_industry_(bars|memberships|current)\b/i.test(sql)) return;
  const requestedStart = typeof params.startDate === 'string'
    ? params.startDate
    : typeof params.start === 'string' ? params.start : null;
  if (!requestedStart) return;
  const relevant = (manifest.datasets ?? []).filter((item) =>
    item.name === 'sw_industry_bars' || item.name === 'sw_industry_memberships',
  );
  const supportedStarts = relevant
    .map((item) => item.minDate)
    .filter((item): item is string => item !== null)
    .map((item) => item.slice(0, 10))
    .sort();
  const supportedStart = supportedStarts[supportedStarts.length - 1];
  if (supportedStart && requestedStart < supportedStart) {
    throw new Error(
      `申万行业研究起始日 ${requestedStart} 早于完整支持边界 ${supportedStart}；`
      + '禁止用当前行业归属回填更早历史。',
    );
  }
}
