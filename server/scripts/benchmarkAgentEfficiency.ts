/** Real provider benchmark without starting HTTP services, schedulers or orphan reconciliation.
 * Run from server/: node --import tsx scripts/benchmarkAgentEfficiency.ts cases.json output-dir [repeats=3]
 * Uses the configured database for NEW agent runs only. Market data is queried by the research agent.
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db/connection.js';
import { AgentRepository } from '../src/services/agent/agentRepository.js';
import { AgentOrchestrator } from '../src/services/agent/agentOrchestrator.js';

const [casesPath, outputPath, repeatArg = '3', ...extra] = process.argv.slice(2);
const repeats = Number(repeatArg);
if (!casesPath || !outputPath || extra.length || !Number.isInteger(repeats) || repeats < 1 || repeats > 10) {
  throw new Error('Usage: benchmarkAgentEfficiency.ts cases.json output-dir [repeats=3, 1..10]');
}
const cases: Array<{ id: string; prompt: string; provider?: 'claude' | 'pi' }> = JSON.parse(await readFile(resolve(casesPath), 'utf8'));
if (!Array.isArray(cases) || !cases.length || cases.some(item => !/^[a-z0-9-]+$/.test(item.id) || !item.prompt?.trim())
  || cases.some(item => item.provider && !['claude', 'pi'].includes(item.provider))
  || new Set(cases.map(item => item.id)).size !== cases.length) throw new Error('Invalid or duplicate benchmark cases');
const config = loadConfig();
const output = resolve(outputPath);
await mkdir(output, { recursive: true });
// New output directories prevent silently overwriting evidence from an earlier run.
await writeFile(resolve(output, 'manifest.json'), JSON.stringify({ cases, repeats, startedAt: new Date().toISOString(),
  providers: [...new Set(cases.map(item => item.provider ?? 'claude'))],
  workingDirectories: { claude: resolve(config.AGENT_CLAUDE_WORKING_DIRECTORY), pi: config.AGENT_PI_WORKING_DIRECTORY }, timeoutMs: 720_000,
}, null, 2), { flag: 'wx' });
const pool = createPool(config);
const repo = new AgentRepository(pool);
const orchestrator = new AgentOrchestrator(pool, {
  claudeWorkingDirectory: resolve(config.AGENT_CLAUDE_WORKING_DIRECTORY), claudePath: config.AGENT_CLAUDE_PATH,
  claudeGitBashPath: config.AGENT_CLAUDE_GIT_BASH_PATH || undefined,
  reportRoot: resolve(output, 'artifacts'), maxConcurrent: 1, defaultProvider: 'claude',
  pi: { enabled: config.AGENT_PI_ENABLED === 'true', piPath: config.AGENT_PI_PATH,
    workingDirectory: config.AGENT_PI_WORKING_DIRECTORY, agentDirectory: config.AGENT_PI_AGENT_DIRECTORY,
    model: config.AGENT_PI_MODEL || undefined, modelProvider: config.AGENT_PI_MODEL_PROVIDER || undefined },
});
let stopped = false;
const stop = () => { stopped = true; void orchestrator.shutdown(); };
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
try {
  for (let repeat = 1; repeat <= repeats && !stopped; repeat++) {
    for (const item of cases) {
      if (stopped) break;
      const runId = randomUUID();
      const name = `after-${item.id}-${repeat}`;
      await repo.createRun(runId, item.prompt, 0, 720_000, 'classic-blue', undefined, runId, 0, item.provider ?? 'claude');
      await writeFile(resolve(output, `${name}.started.json`), JSON.stringify({ id: runId, case: item.id, repeat }));
      console.log(name, runId);
      try { await orchestrator.start({ runId, prompt: item.prompt, maxTurns: 0, timeoutMs: 720_000, provider: item.provider ?? 'claude' }); }
      catch (error) { console.error(name, 'startup failed; inspect persisted terminal event'); }
      let run = await repo.getRun(runId);
      while (run && (orchestrator.isRunning(runId) || !['completed', 'failed', 'canceled'].includes(run.status))) {
        await delay(1000);
        run = await repo.getRun(runId);
      }
      const events = await repo.getEvents(runId);
      const report = await repo.getReport(runId);
      await writeFile(resolve(output, `${name}.json`), JSON.stringify({ case: item, run: { run, report }, events: { events } }, null, 2));
      console.log(name, run?.status);
    }
  }
} finally {
  await orchestrator.shutdown();
  await pool.end();
}
