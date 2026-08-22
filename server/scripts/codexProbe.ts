import 'dotenv/config';
import { resolve } from 'node:path';
import { CodexAgentProvider } from '../src/services/agent/providers/codexAgentProvider.js';

const workingDirectory = resolve(process.env.AGENT_CODEX_WORKING_DIRECTORY ?? '');
const codexHome = resolve(process.env.AGENT_CODEX_HOME ?? '');
if (!process.env.AGENT_CODEX_WORKING_DIRECTORY || !process.env.AGENT_CODEX_HOME) {
  throw new Error('请先配置 AGENT_CODEX_WORKING_DIRECTORY 和 AGENT_CODEX_HOME');
}
if (!process.env.AGENT_CODEX_API_KEY) {
  throw new Error('请先配置项目专用 AGENT_CODEX_API_KEY；探针不会使用全局 Codex 登录状态');
}

const provider = new CodexAgentProvider({
  enabled: true,
  codexPath: process.env.AGENT_CODEX_PATH || 'codex',
  workingDirectory,
  codexHome,
  apiKey: process.env.AGENT_CODEX_API_KEY,
  modelProvider: process.env.AGENT_CODEX_MODEL_PROVIDER || undefined,
  baseUrl: process.env.AGENT_CODEX_BASE_URL || undefined,
  modelCatalogPath: process.env.AGENT_CODEX_MODEL_CATALOG
    ? resolve(process.env.AGENT_CODEX_MODEL_CATALOG)
    : undefined,
  model: process.env.AGENT_CODEX_MODEL || undefined,
  approvalsEnabled: process.env.AGENT_CODEX_APPROVALS_ENABLED === 'true',
  toolsEnabled: process.env.AGENT_CODEX_TOOLS_ENABLED === 'true',
});

const health = provider.health();
if (!health.available) throw new Error(health.reason ?? 'Codex Provider 不可用');

let sessionId = '';
const cancelProbe = process.argv.includes('--cancel');
const resumeId = process.argv.slice(2).find(value => value !== '--cancel');
const run = await provider.start({
  runId: `probe-${Date.now()}`,
  prompt: cancelProbe ? '请执行一个持续 30 秒的等待命令，然后回答等待完成。' : `只回答“Codex 连通性探针通过”，不要调用工具。最后追加：

\`\`\`agent-report
{"generate":false,"reason":"连通性探针"}
\`\`\``,
  maxTurns: 1,
  resumeSessionId: resumeId || undefined,
}, {
  event: async event => {
    if (event.type === 'assistant_final' || event.type === 'error' || event.type === 'terminal') {
      process.stdout.write(`${event.type}: ${event.publicContent}\n`);
    }
  },
  session: async value => { sessionId = value; },
  reportDecision: async generate => process.stdout.write(`report.generate=${generate}\n`),
  approval: async request => {
    process.stdout.write(`approval.requested=${request.requestType}\n`);
    return 'denied';
  },
});

if (cancelProbe) {
  await new Promise(resolve => setTimeout(resolve, 1_000));
  await run.cancel();
}
const completion = await run.completion;
process.stdout.write(`threadId=${sessionId}\nstatus=${completion.status}\n`);
const expected = cancelProbe ? 'interrupted' : 'completed';
if (completion.status !== expected) process.exitCode = 1;
