import 'dotenv/config';
import { resolve } from 'node:path';
import { ClaudeAgentProvider } from '../src/services/agent/providers/claudeAgentProvider.js';

const provider = new ClaudeAgentProvider({ workingDirectory: resolve(process.env.AGENT_CLAUDE_WORKING_DIRECTORY || '..'),
  claudePath: process.env.AGENT_CLAUDE_PATH || 'claude', gitBashPath: process.env.AGENT_CLAUDE_GIT_BASH_PATH });
const health = provider.health();
if (!health.available) throw new Error(health.reason || 'Provider unavailable');
const run = await provider.start({ runId: `linux-probe-${Date.now()}`, maxTurns: 1,
  prompt: '只回答 Claude Linux 连通性通过，不调用工具。', resumeSessionId: process.argv[2] }, {
  event: async event => { if (['assistant_final', 'error'].includes(event.type)) console.log(`${event.type}: ${event.publicContent}`); },
  session: async sessionId => { console.log(`sessionId=${sessionId}`); }, reportDecision: async () => {},
});
const timer = setTimeout(() => { void run.cancel(); }, 60_000);
try {
  const result = await run.completion;
  console.log(JSON.stringify(result));
  if (result.status !== 'completed') process.exitCode = 1;
} finally { clearTimeout(timer); await provider.shutdown(); }
