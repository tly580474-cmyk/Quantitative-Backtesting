/** Validate before opening DuckDB: ignored arguments must never become a successful preview. */
const valueOptions = [
  '--db', '--snapshot-root', '--sql', '-q', '--file', '--out', '-o', '--out-dir', '--format', '-f',
  '--threads', '--max-memory', '--param', '-p', '--params-file', '--view', '--minute-root',
  '--interval', '--days', '--max-output-files', '--factor', '--weight', '--market', '--symbol',
  '--where', '--start', '--end', '--date', '--top', '--limit', '--min-amount', '--horizon',
  '--layers', '--period', '--rolling-window',
];
const booleanOptions = [
  '--no-snapshot-view', '--transaction', '--dry-run', '--echo-sql', '--explain',
  '--continue-on-error', '--factors', '--include-auction', '--split-by-symbol', '--allow-unmanaged-parquet-glob',
];
const repeatable = new Set(['--param', '--factor', '--weight', '--market', '--symbol', '--where']);
const aliases: Record<string, string> = { '-q': '--sql', '-o': '--out', '-f': '--format', '-p': '--param', '--limit': '--top' };

export function validateDuckdbArguments(command: string, args: string[]): void {
  const seen = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const option = args[i];
    const key = aliases[option] ?? option;
    if (!valueOptions.includes(option) && !booleanOptions.includes(option)) {
      throw new Error(`INVALID_ARGUMENT: 未识别参数 ${option}。查询使用 query --sql "SELECT ..." 或 query --file query.sql；字段使用 schema --view bars。`);
    }
    if (seen.has(key) && !repeatable.has(key)) throw new Error(`INVALID_ARGUMENT: 参数 ${key} 不能重复`);
    if (valueOptions.includes(option)) {
      const value = args[++i];
      if (!value?.trim() || valueOptions.includes(value) || booleanOptions.includes(value) || /^--[a-z]/i.test(value)) {
        throw new Error(`INVALID_ARGUMENT: ${option} 缺少参数值`);
      }
      seen.set(key, value);
    } else seen.set(key, 'true');
  }
  if (seen.has('--sql') && seen.has('--file')) throw new Error('INVALID_ARGUMENT: --sql 与 --file 不能同时使用');
  if (command === 'query' && !seen.has('--sql') && !seen.has('--file')) {
    throw new Error('INVALID_ARGUMENT: query 必须提供 --sql 或 --file；查看样例请使用 preview --view bars');
  }
  if (command === 'preview' && (seen.has('--sql') || seen.has('--file'))) {
    throw new Error('INVALID_ARGUMENT: preview 不接受 SQL；使用 query --sql 或 query --file');
  }
  if (['pipeline', 'batch'].includes(command) && !seen.has('--file')) {
    throw new Error(`INVALID_ARGUMENT: ${command} 必须提供 --file`);
  }
}
