import 'dotenv/config';
import assert from 'node:assert/strict';
import { CodexAgentProvider } from '../src/services/agent/providers/codexAgentProvider.ts';

assert.equal(process.platform, 'linux');
assert.equal(process.env.BACKGROUND_JOBS_ENABLED, 'false');
const provider = new CodexAgentProvider({
  enabled: true, codexPath: process.env.AGENT_CODEX_PATH,
  workingDirectory: process.env.AGENT_CODEX_WORKING_DIRECTORY,
  codexHome: process.env.AGENT_CODEX_HOME, apiKey: process.env.AGENT_CODEX_API_KEY,
  modelProvider: process.env.AGENT_CODEX_MODEL_PROVIDER, baseUrl: process.env.AGENT_CODEX_BASE_URL,
  model: process.env.AGENT_CODEX_MODEL, modelCatalogPath: process.env.AGENT_CODEX_MODEL_CATALOG,
  toolsEnabled: true, approvalsEnabled: false,
  sandboxMode: process.env.AGENT_CODEX_SANDBOX_MODE,
  networkEnabled: process.env.AGENT_CODEX_NETWORK_ENABLED === 'true',
  pythonPath: process.env.AGENT_CODEX_PYTHON_PATH,
});
let successfulCommand = false;
const run = await provider.start({
  runId: `linux-tool-probe-${Date.now()}`, maxTurns: 3,
  prompt: '这是 Ubuntu 部署验收。仅使用命令工具执行 python --version；不要读取其他文件，不要联网，不要生成报告。成功后简短报告实际版本。',
}, {
  event: async event => {
    if (event.type === 'tool_finished' && event.toolName === 'command') {
      const result = JSON.parse(event.toolResult || '{}');
      successfulCommand ||= result.exitCode === 0 && /Python 3\./.test(result.output || '');
      console.log(event.type, event.toolResult);
    }
    if (['error', 'assistant_final'].includes(event.type)) console.log(event.type, event.publicContent);
  },
  session: async () => {}, reportDecision: async () => {}, approval: async () => 'denied',
});
const timeout = setTimeout(() => { void run.cancel(); }, 90_000);
try {
  const result = await run.completion;
  assert.equal(result.status, 'completed');
  assert.ok(successfulCommand, 'No successful Python command was observed');
  console.log('PASS real Linux sandbox command and configured Python environment');
} finally { clearTimeout(timeout); await provider.shutdown(); }
