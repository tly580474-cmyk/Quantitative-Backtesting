// @vitest-environment node
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const exec = promisify(execFile);
const runner = fileURLToPath(new URL('../../scripts/linuxJob.mjs', import.meta.url));
async function run(job: string, env: NodeJS.ProcessEnv = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'quant-job-test-'));
  try {
    const bin = join(directory, 'bin'); await mkdir(bin);
    await writeFile(join(bin, 'npm'), `#!${process.execPath}
const fs=require('node:fs'); const name=process.argv.at(-1);
fs.appendFileSync('calls.txt',name+'\\n');
if(name==='schedule:trading-day:check') console.log(JSON.stringify({shouldRun:true}));
if(name==='minute:tdx-online:update') process.exit(Number(process.env.TEST_PRIMARY_EXIT||0));
if(name==='minute:online:update') process.exit(Number(process.env.TEST_FALLBACK_EXIT||0));
`, { mode: 0o755 });
    let failed = false;
    try { await exec(process.execPath, [runner, job, '--run-now'], { cwd: directory,
      env: { ...process.env, QUANT_TEST_MODE: 'false', PATH: `${bin}:${process.env.PATH}`, ...env } }); }
    catch { failed = true; }
    const calls = (await readFile(join(directory, 'calls.txt'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
    const progress = JSON.parse(await readFile(join(directory, '.logs/minute-data/progress.json'), 'utf8').catch(() => '{}'));
    return { calls, failed, progress };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
it.skipIf(process.platform !== 'linux')('preserves research job dependency ordering', async () => {
  const result = await run('research');
  expect(result.failed).toBe(false);
  expect(result.calls).toEqual(['schedule:trading-day:check', 'index:update', 'index:constituents:update',
    'sw-industry:update', 'dividend:current:update', 'dividend:update', 'snapshot:build', 'snapshot:verify']);
});
it.skipIf(process.platform !== 'linux')('does not fetch data in test mode', async () => {
  expect((await run('research', { QUANT_TEST_MODE: 'true' })).calls).toEqual([]);
});
it.skipIf(process.platform !== 'linux')('wait deadline prevents publication through a fallback', async () => {
  const result = await run('minute', { TEST_PRIMARY_EXIT: '3', MINUTE_REFERENCE_WAIT_MINUTES: '0' });
  expect(result.failed).toBe(true);
  expect(result.calls).toEqual(['schedule:trading-day:check', 'minute:tdx-online:update']);
  expect(result.progress.phase).toBe('dependency-timeout');
});
it.skipIf(process.platform !== 'linux')('uses online then local fallback on provider failure', async () => {
  const result = await run('minute', { TEST_PRIMARY_EXIT: '1', TEST_FALLBACK_EXIT: '1' });
  expect(result.failed).toBe(false);
  expect(result.calls).toEqual(['schedule:trading-day:check', 'minute:tdx-online:update', 'minute:online:update', 'minute:tdx:import']);
  expect(result.progress.status).toBe('completed');
});
