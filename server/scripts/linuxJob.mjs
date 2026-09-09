import 'dotenv/config';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const job = process.argv[2];
const schedules = {
  research: ['RESEARCH_SNAPSHOT_MORNING_RETRY_TIME=08:30', 'RESEARCH_SNAPSHOT_UPDATE_TIME=18:00', 'RESEARCH_SNAPSHOT_RETRY_TIME=18:30'],
  minute: ['MINUTE_DATA_UPDATE_TIME=16:30', 'MINUTE_DATA_RETRY_TIME=17:30'],
  'fund-flow': ['FUND_FLOW_UPDATE_TIME=16:20', 'FUND_FLOW_RETRY_TIME=17:20'],
  'tdx-shadow': ['MINUTE_TDX_TCP_SHADOW_TIME=17:00'],
};
if (!schedules[job]) throw new Error('Unknown Linux job');
const root = resolve('.logs', job === 'research' ? 'research-snapshot' : job === 'fund-flow' ? job : 'minute-data');
await mkdir(root, { recursive: true });
const statePath = resolve(root, `${job}-schedule.json`);
const now = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short' }).format(new Date());
const due = schedules[job].map(entry => { const [key, fallback] = entry.split('='); return process.env[key] || fallback; }).includes(now.slice(-5));
if (!process.argv.includes('--run-now')) {
  if (!due) process.exit(0);
  const last = await readFile(statePath, 'utf8').catch(() => '');
  if (last === now) process.exit(0);
  await writeFile(`${statePath}.tmp`, now);
  await rename(`${statePath}.tmp`, statePath);
}
if (process.env.QUANT_TEST_MODE === 'true') {
  console.log(`[${job}] Test mode: automatic external collection disabled; use smoke tests for bounded fixtures.`);
  process.exit(0);
}
async function run(script, capture = false) {
  return new Promise((resolveResult, reject) => {
    const child = spawn('npm', ['run', '--silent', script], { stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit' });
    let output = '';
    child.stdout?.on('data', chunk => { output += chunk; });
    child.once('error', reject);
    child.once('close', code => resolveResult({ code: code ?? 1, output }));
  });
}
async function required(script) {
  const result = await run(script);
  if (result.code) throw new Error(`${script} exited ${result.code}`);
}
const guard = await run('schedule:trading-day:check', true);
if (guard.code) throw new Error(`Trading calendar check failed: ${guard.code}`);
const decision = guard.output.split(/\r?\n/).reverse().find(line => line.trim().startsWith('{'));
if (!decision) throw new Error('Missing trading calendar decision');
if (!JSON.parse(decision).shouldRun) process.exit(0);
if (job === 'research') {
  for (const script of ['index:update', 'index:constituents:update', 'sw-industry:update', 'dividend:current:update', 'dividend:update', 'snapshot:build', 'snapshot:verify']) await required(script);
} else if (job === 'fund-flow') await required('fund-flow:update');
else if (job === 'tdx-shadow') {
  if (process.env.MINUTE_TDX_TCP_SHADOW_ENABLED !== 'false') await required('minute:tdx-online:shadow');
} else {
  const progressPath = resolve(root, 'progress.json');
  process.env.MINUTE_UPDATE_PROGRESS_FILE = progressPath;
  const startedAt = new Date().toISOString();
  async function progress(status, phase, message) {
    const updatedAt = new Date().toISOString();
    await writeFile(`${progressPath}.tmp`, JSON.stringify({ status, phase, message, completed: 0, total: 0, failed: 0,
      startedAt, updatedAt, finishedAt: ['completed', 'failed'].includes(status) ? updatedAt : null }));
    await rename(`${progressPath}.tmp`, progressPath);
  }
  const tcp = process.env.MINUTE_TDX_TCP_ENABLED !== 'false';
  const deadline = Date.now() + Math.max(0, Number(process.env.MINUTE_REFERENCE_WAIT_MINUTES || 30)) * 60_000;
  let result;
  do {
    result = await run(tcp ? 'minute:tdx-online:update' : 'minute:online:update');
    if (result.code !== 3) break;
    if (Date.now() >= deadline) {
      await progress('failed', 'dependency-timeout', 'Final daily bars were not ready before the deadline.');
      process.exit(1);
    }
    await progress('pending', 'waiting-daily-reference', 'Waiting for final daily bars.');
    await sleep(60_000);
  } while (true);
  if (result.code && tcp) result = await run('minute:online:update');
  if (result.code) result = await run('minute:tdx:import');
  await progress(result.code ? 'failed' : 'completed', result.code ? 'failed' : 'completed', `Minute update exited ${result.code}`);
  process.exitCode = result.code;
}
