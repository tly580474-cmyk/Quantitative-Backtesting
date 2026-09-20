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
import { readFile, mkdir, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { fingerprint, withSourceMemory, type ResearchOutcome } from './sourceMemory.js';
import { saveCapsule, reuseCapsule } from './researchCapsule.js';

const exec = promisify(execFile);
const server = fileURLToPath(new URL('../../', import.meta.url));
const workspace = resolve(server, '..');
const commands: Record<string, string[]> = {
  catalog: ['--task'], describe: [], coverage: ['--start', '--end'], doctor: [],
  'fund-flows': ['--end', '--days', '--top', '--group', '--symbol'],
};
const usage: Record<string, string> = {
  catalog: 'catalog [--task fund-flow|cross-sectional|factor|fundamental|event|intraday|quote]',
  describe: 'describe <dataset>', coverage: 'coverage <dataset> [--start YYYY-MM-DD] [--end YYYY-MM-DD]',
  doctor: 'doctor <dataset>', query: 'query --sql "SELECT ..." | --file tmp_output/query.sql [--param name=value] [--params-file file.json]',
  'fund-flows': 'fund-flows [--end YYYY-MM-DD] [--days 1..60] [--group stock|industry] [--top 1..50] [--symbol 600000]',
};
async function duckdb(args: string[]) {
  return exec(process.execPath, [fileURLToPath(new URL('../../node_modules/tsx/dist/cli.mjs', import.meta.url)),
    fileURLToPath(new URL('./duckdbCli.ts', import.meta.url)), ...args],
  { cwd: server, timeout: 60_000, maxBuffer: 8_000_000, windowsHide: true });
}

async function main(argv: string[]) {
  const [command = 'catalog', ...args] = argv;
  if ((['help', '--help', '-h'].includes(command) && !args.length)
    || (usage[command] && args.length === 1 && ['--help', '-h'].includes(args[0]))) {
    return { usage: usage[command] ?? usage, prefix: 'node server/scripts/researchData.mjs',
      note: '从项目根目录执行；文件参数相对根目录；fund-flows已附逐日覆盖，金额由库内元换算为亿元；coverage资金流最多60个交易日。' };
  }
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
    const outputDirectory = resolve(workspace, 'tmp_output', 'research-results');
    await mkdir(outputDirectory, { recursive: true });
    const output = resolve(outputDirectory, `${randomUUID()}.json`);
    await duckdb(['query', ...forwarded, '--format', 'json', '--out', output]);
    const manifestPath = `${output}.manifest.json`;
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const large = (await stat(output)).size > 8_000_000;
    const data = large ? [] : JSON.parse(await readFile(output, 'utf8')) as unknown[];
    if (!Array.isArray(data)) throw new Error('DATA_UNAVAILABLE: 查询结果不是行数组');
    const rowCount = manifest.outputs?.[0]?.rows ?? data.length;
    return { kind: 'research-data', ok: true, usable: rowCount > 0, source: 'published-duckdb-snapshot',
      snapshotId: manifest.snapshot?.snapshotId ?? null, retrievedAt: new Date().toISOString(),
      resultPath: output, manifestPath, rowCount, truncated: large || data.length > 50, sample: data.slice(0, 50),
      note: '完整结果和实际连接快照保存在导出文件及manifest；sample最多50行，超过8MB时不注入预览。字段口径由SQL决定。' };
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
      return await queryFundFlows(pool, {
        end: flags.get('--end') ?? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()),
        days: Number(flags.get('--days') ?? 5), top: Number(flags.get('--top') ?? 10),
        group: (flags.get('--group') ?? 'stock') as 'stock' | 'industry', symbol: flags.get('--symbol'),
        ...(command === 'coverage' && flags.has('--start') ? { start: flags.get('--start') } : {}),
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
async function execute(argv: string[]): Promise<ResearchOutcome> {
  try { return { value: await main(argv), exitCode: 0 }; } catch (error: any) {
  const detail = sanitizePublicContent(error.stderr || error.message);
  return { value: { kind: 'research-data', ok: false,
    errorCategory: detectToolFailure(detail, true)?.category, error: detail,
    next: '参数错误按示例修正；字段错误查schema；覆盖不足说明缺失项；短暂网络故障最多自动重试1次。替代来源最多1个且必须验证口径，仍不可用则交付缺失说明。' },
    exitCode: typeof error.code === 'number' && error.code > 0 && error.code < 256 ? error.code : 1 };
  }
}
async function run() {
  const raw = process.argv.slice(2);
  const refresh = raw.includes('--refresh');
  const argv = raw.filter(arg => arg !== '--refresh');
  const saveIndex = argv.indexOf('--save');
  const save = saveIndex < 0 ? undefined : argv.splice(saveIndex, 2)[1];
  if (saveIndex >= 0 && !save) throw new Error('INVALID_ARGUMENT: --save 缺少路径');
  // File contents, scope, implementation version and published pointer all invalidate memory.
  const files: string[] = [];
  for (let i = 0; i < argv.length; i++) if (['--file', '--params-file'].includes(argv[i]) && argv[i + 1]) {
    files.push(await readFile(resolve(workspace, argv[i + 1]), 'utf8').catch(() => 'missing'));
  }
  const pointer = await readFile(resolve(loadConfig().RESEARCH_SNAPSHOT_ROOT, 'current.json'), 'utf8').catch(() => 'missing');
  if (argv[0] === 'reuse') {
    if (argv.length !== 3 || argv[1] !== '--file') throw new Error('INVALID_ARGUMENT: reuse --file <产物.json>');
    const reused = await reuseCapsule(workspace, argv[2], pointer);
    process.stdout.write(`${JSON.stringify(reused, null, 2)}\n`);
    process.exitCode = reused.reusable ? 0 : 2;
    return;
  }
  const outcome = await withSourceMemory(resolve(workspace, 'tmp_output', 'source-memory', fingerprint(homedir())),
    { version: 1, argv, files, pointer, workspace }, () => execute(argv), { refresh });
  if (save) outcome.value.artifact = await saveCapsule(workspace, save, outcome.value,
    { argv, snapshotPointer: pointer, inputHashes: files.map(fingerprint) });
  process.stdout.write(`${JSON.stringify(outcome.value, null, 2)}\n`);
  process.exitCode = outcome.exitCode;
}
run().catch(error => { process.stderr.write(`${sanitizePublicContent(error.message)}\n`); process.exitCode = 1; });
