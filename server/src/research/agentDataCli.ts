import 'dotenv/config';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.js';
import { readCurrentSnapshot } from './snapshotManifest.js';
import { DATASETS, catalogDataset, datasetCoverage } from './agentDataCatalog.js';
import { sanitizePublicContent } from '../services/agent/eventProtocol.js';

const exec = promisify(execFile);
async function main() {
  const [command = 'catalog', ...args] = process.argv.slice(2);
  const flags = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      if (!['--task', '--start', '--end'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('INVALID_ARGUMENT: 无效选项');
      flags.set(args[i], args[++i]);
    } else positional.push(args[i]);
  }
  if (!['catalog', 'describe', 'coverage', 'doctor'].includes(command)) throw new Error('INVALID_ARGUMENT: 使用 catalog、describe、coverage 或 doctor');
  for (const key of ['--start', '--end']) {
    const value = flags.get(key);
    if (value && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || new Date(value).toISOString().slice(0, 10) !== value)) throw new Error('INVALID_ARGUMENT: 日期必须为有效 YYYY-MM-DD');
  }
  if (flags.get('--start') && flags.get('--end') && flags.get('--start')! > flags.get('--end')!) throw new Error('INVALID_ARGUMENT: start 不能晚于 end');
  if (command === 'catalog') {
    const task = flags.get('--task');
    const datasets = DATASETS.filter(item => !task || item.task === task);
    if (!datasets.length) throw new Error('INVALID_ARGUMENT: task 使用 cross-sectional|factor|fundamental|event|intraday|quote');
    return { datasets, next: 'describe <id> 查看字段与示例；coverage <id> 检查覆盖；doctor <id> 检查可用性', policy: '目录不联网、不扫描行情；执行前按所选数据集检查。' };
  }
  const dataset = catalogDataset(positional[0] ?? '');
  if (!dataset.view) {
    const subcommand = dataset.id === 'minute_bars' ? 'minute-catalog' : 'health';
    if (command === 'describe') return { dataset, examples: dataset.id === 'minute_bars'
      ? ['cd server; npm run duckdb -- minute --symbol 002155 --days 30 --interval 5m']
      : ['node server/scripts/agentMarketData.mjs catalog'], coverage: '按实际接口返回检查，不将健康检查视为数据完整性证明。' };
    const result = await exec(process.execPath, [fileURLToPath(new URL('../../scripts/agentMarketData.mjs', import.meta.url)), subcommand], { timeout: 65_000, maxBuffer: 2_000_000, windowsHide: true });
    return { dataset: dataset.id, requestedRange: Object.fromEntries(flags), result: JSON.parse(result.stdout), note: '目录总体覆盖不保证逐证券覆盖；market/news 的 health 仅检查后端服务。' };
  }
  const config = loadConfig();
  const current = await readCurrentSnapshot(config.RESEARCH_SNAPSHOT_ROOT);
  const coverage = datasetCoverage(dataset.id, current?.manifest ?? null, flags.get('--start'), flags.get('--end'));
  if (command === 'coverage') return coverage;
  const result = await exec(process.execPath, [
    fileURLToPath(new URL('../../node_modules/tsx/dist/cli.mjs', import.meta.url)),
    fileURLToPath(new URL('./duckdbCli.ts', import.meta.url)), 'schema', '--view', dataset.view, '--format', 'json',
  ], { timeout: 30_000, maxBuffer: 1_000_000, windowsHide: true });
  return { dataset, coverage, schema: JSON.parse(result.stdout),
    examples: [`在 server 目录: npm run duckdb -- query --sql "SELECT * FROM ${dataset.view} LIMIT 5" --format json`, '批量研究先限制日期和字段；多行SQL写入文件，用 --file 执行。'],
    checkedAt: new Date().toISOString() };
}
main().then(result => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)).catch(error => {
  const detail = sanitizePublicContent(error.stderr || error.message);
  process.stdout.write(`${JSON.stringify({ ok: false, error: detail, next: '参数错误请查看 catalog；缺少视图检查快照；服务不可用检查入口，不重复原样调用。' })}\n`);
  process.exitCode = 1;
});
