import 'dotenv/config';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { loadConfig } from '../config.js';
import { createPool } from '../db/connection.js';
import { readCurrentSnapshot } from './snapshotManifest.js';
import { DATASETS, catalogDataset, datasetCoverage, datasetEntry } from './agentDataCatalog.js';
import { FUND_FLOW_FIELDS, queryFundFlows } from './fundFlowResearch.js';
import { sanitizePublicContent } from '../services/agent/eventProtocol.js';
import { detectToolFailure } from '../services/agent/toolOutcome.js';

const exec = promisify(execFile);
const server = fileURLToPath(new URL('../../', import.meta.url));
const workspace = resolve(server, '..');
const commands: Record<string, string[]> = {
  catalog: ['--task'], describe: [], coverage: ['--start', '--end'], doctor: [],
  'fund-flows': ['--end', '--days', '--top', '--group', '--symbol'],
};
async function duckdb(args: string[]) {
  return exec(process.execPath, [fileURLToPath(new URL('../../node_modules/tsx/dist/cli.mjs', import.meta.url)),
    fileURLToPath(new URL('./duckdbCli.ts', import.meta.url)), ...args],
  { cwd: server, timeout: 60_000, maxBuffer: 8_000_000, windowsHide: true });
}

async function main() {
  const [command = 'catalog', ...args] = process.argv.slice(2);
  if (command === 'query') {
    // Fixed cwd and path semantics; no shell or output-truncating pipeline.
    const forwarded: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const flag = args[i];
      if (!['--sql', '--file', '--param', '--params-file'].includes(flag) || !args[i + 1]?.trim()) {
        throw new Error('INVALID_ARGUMENT: query 使用 --sql 或 --file，可附 --param/--params-file；大结果导出使用 server 下 DuckDB CLI 的 --out');
      }
      let value = args[++i];
      if (['--file', '--params-file'].includes(flag)) value = resolve(workspace, value);
      forwarded.push(flag, value);
    }
    const result = await duckdb(['query', ...forwarded, '--format', 'json']);
    const data = JSON.parse(result.stdout) as unknown[];
    if (!Array.isArray(data)) throw new Error('DATA_UNAVAILABLE: 查询结果不是行数组');
    const current = await readCurrentSnapshot(loadConfig().RESEARCH_SNAPSHOT_ROOT);
    return { kind: 'research-data', ok: true, usable: data.length > 0, source: 'published-duckdb-snapshot',
      snapshotIdObservedAfterQuery: current?.manifest.snapshotId ?? null, retrievedAt: new Date().toISOString(),
      rowCount: data.length, truncated: data.length > 50, sample: data.slice(0, 50),
      note: data.length > 50 ? '仅展示前50行；完整分析请在SQL内聚合或使用DuckDB --out导出，不能把sample当全量。' : '全部结果行；字段语义以所查询视图和SQL为准。' };
  }
  if (!commands[command]) throw new Error('INVALID_ARGUMENT: 使用 catalog、describe、coverage、doctor、query 或 fund-flows');
  const flags = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const flag = args[i]; const value = args[++i];
      if (!commands[command].includes(flag) || flags.has(flag) || !value?.trim() || value.startsWith('--')) throw new Error('INVALID_ARGUMENT: 无效、重复或缺值的选项');
      flags.set(flag, value);
    } else positional.push(args[i]);
  }
  if (positional.length !== (['describe', 'coverage', 'doctor'].includes(command) ? 1 : 0)) throw new Error('INVALID_ARGUMENT: 数据集参数数量不正确');
  for (const key of ['--start', '--end']) {
    const value = flags.get(key);
    if (value && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)) throw new Error('INVALID_ARGUMENT: 日期必须为有效 YYYY-MM-DD');
  }
  if (flags.get('--start') && flags.get('--end') && flags.get('--start')! > flags.get('--end')!) throw new Error('INVALID_ARGUMENT: start 不能晚于 end');
  if (command === 'fund-flows' || positional[0] === 'fund_flows') {
    if (command === 'describe') return { dataset: datasetEntry('fund_flows'), fields: FUND_FLOW_FIELDS,
      coverage: '执行fund-flows时一次返回逐日样本、来源和缺失日期；不以服务health代替覆盖检查。' };
    const pool = createPool(loadConfig());
    try {
      if (flags.has('--start')) throw new Error('INVALID_ARGUMENT: 资金流覆盖使用 fund-flows --end YYYY-MM-DD --days N，以交易日窗口查询');
      return await queryFundFlows(pool, {
        end: flags.get('--end') ?? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()),
        days: Number(flags.get('--days') ?? 5), top: Number(flags.get('--top') ?? 10),
        group: (flags.get('--group') ?? 'stock') as 'stock' | 'industry', symbol: flags.get('--symbol'),
      });
    } finally { await pool.end(); }
  }
  if (command === 'catalog') {
    const datasets = DATASETS.filter(item => !flags.get('--task') || item.task === flags.get('--task')).map(item => datasetEntry(item.id));
    if (!datasets.length) throw new Error('INVALID_ARGUMENT: task 使用 fund-flow|cross-sectional|factor|fundamental|event|intraday|quote');
    return { datasets, next: '直接执行command，或describe <id>查看字段和覆盖；目录不联网、不扫描行情。' };
  }
  const dataset = catalogDataset(positional[0]);
  if (dataset.source === 'unsupported') return { dataset, available: false, status: 'unsupported',
    next: '不得将个股估值静默当作官方指数估值；明确缺失项，任务允许代理口径时另行验证。' };
  if (!dataset.view) {
    const subcommand = dataset.id === 'minute_bars' ? 'minute-catalog' : 'health';
    if (command === 'describe') return { dataset, examples: dataset.id === 'minute_bars'
      ? ['cd server; npm run duckdb -- minute --symbol 002155 --days 30 --interval 5m']
      : ['node server/scripts/agentMarketData.mjs catalog'], coverage: '按实际接口返回检查，不将健康检查视为数据完整性证明。' };
    const result = await exec(process.execPath, [fileURLToPath(new URL('../../scripts/agentMarketData.mjs', import.meta.url)), subcommand], { cwd: server, timeout: 65_000, maxBuffer: 2_000_000, windowsHide: true });
    return { dataset: dataset.id, requestedRange: Object.fromEntries(flags), result: JSON.parse(result.stdout), note: '目录总体覆盖不保证逐证券覆盖；market/news 的 health 仅检查后端服务。' };
  }
  const current = await readCurrentSnapshot(loadConfig().RESEARCH_SNAPSHOT_ROOT);
  const coverage = datasetCoverage(dataset.id, current?.manifest ?? null, flags.get('--start'), flags.get('--end'));
  if (command === 'coverage') return coverage;
  const result = await duckdb(['schema', '--view', dataset.view, '--format', 'json']);
  return { dataset, coverage, schema: JSON.parse(result.stdout), examples: [
    `node server/scripts/researchData.mjs query --sql "SELECT * FROM ${dataset.view} LIMIT 5"`,
    'node server/scripts/researchData.mjs query --file tmp_output/query.sql',
  ], checkedAt: new Date().toISOString() };
}
main().then(result => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)).catch(error => {
  const detail = sanitizePublicContent(error.stderr || error.message);
  process.stdout.write(`${JSON.stringify({ kind: 'research-data', ok: false,
    errorCategory: detectToolFailure(detail, true)?.category, error: detail,
    next: '参数错误按命令示例修正；覆盖不足说明缺失项；服务不可用检查入口，不重复原样调用。' })}\n`);
  process.exitCode = typeof error.code === 'number' && error.code > 0 && error.code < 256 ? error.code : 1;
});
