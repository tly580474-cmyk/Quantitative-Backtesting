import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { terminateProcessTree } from './processUtils.js';

it.skipIf(process.platform !== 'linux')('cancels a provider and its spawned tool process together', async () => {
  const script = `const {spawn}=require('node:child_process');
    const tool=spawn(process.execPath,['-e','setInterval(()=>{},1000)']);
    console.log(tool.pid); setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['-e', script], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const toolPid = await new Promise<number>((resolve, reject) => {
    child.stdout!.once('data', data => resolve(Number(String(data).trim())));
    child.once('error', reject);
  });
  try {
    expect(toolPid).toBeGreaterThan(1);
    terminateProcessTree(child);
    let stopped = false;
    for (let i = 0; i < 40; i++) {
      const stat = await readFile(`/proc/${toolPid}/stat`, 'utf8').catch(() => '');
      if (!stat || stat.split(') ')[1]?.startsWith('Z')) { stopped = true; break; }
      await sleep(50);
    }
    expect(stopped).toBe(true);
  } finally {
    try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* Already canceled. */ }
  }
});
