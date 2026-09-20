/** Real Pi acceptance: creates only new synthetic conversations/artifacts, never changes settings.
 * From server/: node --import tsx scripts/acceptPiProvider.mjs <new-output-dir> [--isolated]
 * Default targets the running backend at 127.0.0.1:3001. --isolated starts only Agent routes
 * on a random loopback port, without schedulers or orphan reconciliation; requires a staging workspace.
 */
import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from '../src/config.js';
import { PiAgentProvider } from '../src/services/agent/providers/piAgentProvider.js';

const [outArg, mode, ...extra] = process.argv.slice(2);
assert.ok(outArg && (!mode || mode === '--isolated') && !extra.length, 'Usage: acceptPiProvider.mjs output-dir [--isolated]');
const config = loadConfig();
const output = resolve(outArg);
await mkdir(output, { recursive: true });
const evidence = { startedAt: new Date().toISOString(), mode: mode ?? 'live', checks: [], runs: [] };
await writeFile(join(output, 'acceptance.json'), JSON.stringify(evidence, null, 2), { flag: 'wx' });
let app, pool, orchestrator;
let base = 'http://127.0.0.1:3001';
const ownedRuns = new Set();
const save = () => writeFile(join(output, 'acceptance.json'), JSON.stringify(evidence, null, 2));
const headers = { 'Content-Type': 'application/json' };
async function request(path, body) {
  const response = await fetch(base + path, { ...(body ? { method: 'POST', headers, body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20_000) });
  assert.ok(response.ok, `${path}: HTTP ${response.status}`);
  return response.json();
}
async function run(prompt, { attachmentIds = [], parent, cancel = false } = {}) {
  const start = Date.now();
  const created = await request(parent ? `/api/agent/runs/${parent}/continue` : '/api/agent/runs',
    { provider: 'pi', prompt, attachmentIds, timeoutMinutes: 3 });
  ownedRuns.add(created.runId);
  evidence.runs.push({ id: created.runId, parent: parent ?? null });
  await save();
  const response = await fetch(`${base}/api/agent/runs/${created.runId}/stream`, { signal: AbortSignal.timeout(200_000) });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const decoder = new TextDecoder();
  let buffer = '', cancelAt = null;
  const events = [];
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trimEnd(); buffer = buffer.slice(newline + 1);
      if (!line.startsWith('data: ')) continue;
      const event = JSON.parse(line.slice(6)); events.push(event);
      if (cancel && cancelAt === null && event.type === 'tool_started' && event.toolName === 'bash') {
        await delay(800); cancelAt = Date.now();
        await request(`/api/agent/runs/${created.runId}/cancel`, {});
      }
    }
  }
  const detail = await request(`/api/agent/runs/${created.runId}`);
  await writeFile(join(output, `${created.runId}.json`), JSON.stringify({ detail, events }, null, 2));
  const expected = cancel ? 'canceled' : 'completed';
  assert.equal(events.filter(event => event.type === 'terminal').length, 1);
  assert.equal(events.at(-1).terminal?.status, expected);
  assert.equal(detail.run.status, expected);
  assert.equal(detail.run.provider, 'pi');
  if (!cancel) assert.ok(detail.run.sessionId);
  if (cancel) assert.ok(cancelAt && Date.now() - cancelAt < 8_000, 'Cancellation must settle within 8s');
  const record = { id: created.runId, status: expected, elapsedMs: Date.now() - start,
    ...(cancelAt ? { cancelMs: Date.now() - cancelAt } : {}), eventCount: events.length, sessionId: detail.run.sessionId };
  Object.assign(evidence.runs.at(-1), record);
  await save(); console.log(JSON.stringify(record));
  return { id: created.runId, detail, events, text: events.filter(event => event.type === 'assistant_final').map(event => event.publicContent).join('\n') };
}
try {
  if (mode === '--isolated') {
    assert.notEqual(resolve(config.AGENT_PI_WORKING_DIRECTORY), '/opt/quant-backtest', 'Isolated acceptance requires a staging workspace');
    const { default: Fastify } = await import('fastify');
    const { default: multipart } = await import('@fastify/multipart');
    const { createPool } = await import('../src/db/connection.js');
    const { AgentOrchestrator } = await import('../src/services/agent/agentOrchestrator.js');
    const { registerAgentRoutes } = await import('../src/routes/agent.js');
    pool = createPool(config);
    orchestrator = new AgentOrchestrator(pool, {
      claudeWorkingDirectory: config.AGENT_PI_WORKING_DIRECTORY, claudePath: config.AGENT_CLAUDE_PATH,
      reportRoot: join(output, 'artifacts'), maxConcurrent: 1, defaultProvider: 'pi',
      pi: { enabled: true, piPath: config.AGENT_PI_PATH, workingDirectory: config.AGENT_PI_WORKING_DIRECTORY,
        agentDirectory: config.AGENT_PI_AGENT_DIRECTORY, model: config.AGENT_PI_MODEL, modelProvider: config.AGENT_PI_MODEL_PROVIDER },
    });
    app = Fastify(); await app.register(multipart);
    registerAgentRoutes(app, true, { pool, orchestrator, reportRoot: join(output, 'artifacts'), enabled: true, config,
      attachmentRoot: join(output, 'attachments'), workspaceRoot: config.AGENT_PI_WORKING_DIRECTORY });
    base = await app.listen({ host: '127.0.0.1', port: 0 });
  }
  const providers = await request('/api/agent/providers');
  assert.ok(providers.providers.find(provider => provider.id === 'pi')?.available);
  evidence.defaultProvider = providers.defaultProvider;
  evidence.checks.push('provider-discovery');
  const nonce = `PI_ACCEPT_${randomUUID().replaceAll('-', '')}`;
  const form = new FormData();
  form.append('file', new Blob([`验收附件中的识别码为 ${nonce}。这是一条合成测试数据，与金融行情无关。`]), 'pi-acceptance.txt');
  const upload = await fetch(base + '/api/agent/attachments', { method: 'POST', body: form, signal: AbortSignal.timeout(20_000) });
  assert.equal(upload.status, 201); const attachment = (await upload.json()).attachment;
  const first = await run('这是 Pi 接口验收。执行一次 bash 命令 printf PI_TOOL_OK，再输出附件中的完整识别码。不要读取其他文件，不要调研，不要生成报告。', { attachmentIds: [attachment.id] });
  assert.ok(first.text.includes(nonce));
  assert.ok(first.events.some(event => event.type === 'tool_finished' && event.toolResult?.includes('PI_TOOL_OK')));
  assert.equal(first.detail.attachments.length, 1);
  evidence.checks.push('attachment', 'tool-events', 'SSE-terminal', 'persistence');
  const resumed = await run('继续刚才的验收：不要使用工具，仅回忆并输出上轮附件中的完整识别码，不要生成报告。', { parent: first.id });
  assert.ok(resumed.text.includes(nonce));
  assert.equal(resumed.detail.run.sessionId, first.detail.run.sessionId);
  assert.equal(resumed.detail.run.conversationId, first.detail.run.conversationId);
  evidence.checks.push('exact-session-resume');
  const mismatch = await fetch(base + `/api/agent/runs/${first.id}/continue`, { method: 'POST', headers,
    body: JSON.stringify({ provider: 'claude', prompt: 'synthetic mismatch test' }) });
  assert.equal(mismatch.status, 409); evidence.checks.push('provider-mismatch-guard');
  const replay = await fetch(base + `/api/agent/runs/${first.id}/stream`, { headers: { 'Last-Event-ID': String(first.events.at(-2).seq) }, signal: AbortSignal.timeout(10_000) });
  const replayEvents = (await replay.text()).split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
  assert.equal(replayEvents.length, 1); assert.equal(replayEvents[0].type, 'terminal');
  evidence.checks.push('SSE-resume');
  const report = await run('这是 Pi 报告链路验收，使用合成数据，不查询真实行情。请用 server/scripts/researchPlot.py 生成一张中文折线图，数据为一月1、二月2、三月3，来源标注“验收合成数据”，输出到本任务产物目录。生成题为“Pi合成数据验收”的简短中文报告，正文嵌入图片、列出3行数据并说明不是投资建议；用绿色强调色 #16803d 和宽版布局。不要重复装饰图片，不需要其他调研。');
  assert.ok(report.detail.report, 'Report must exist');
  const htmlResponse = await fetch(base + `/api/agent/reports/${report.id}/html`);
  assert.equal(htmlResponse.status, 200);
  assert.match(htmlResponse.headers.get('content-security-policy'), /sandbox/);
  const html = await htmlResponse.text();
  assert.match(html, /data:image\/png;base64,/); assert.match(html, /#16803d/i); assert.match(html, /验收合成数据/);
  const download = await fetch(base + `/api/agent/reports/${report.id}/download`);
  assert.equal(download.status, 200); assert.match(download.headers.get('content-disposition'), /attachment/);
  assert.match(await download.text(), /data:image\/png;base64,/);
  await writeFile(join(output, 'report.html'), html);
  evidence.checks.push('report-html', 'embedded-chart', 'custom-presentation', 'report-download');
  const pidFile = join(output, 'cancel-child.pid');
  assert.ok(!/[\s'"`$]/.test(pidFile), 'Use a simple absolute output path');
  await run(`取消功能验收：只执行 bash 命令 echo $$ > ${pidFile}; sleep 30。不要使用其他工具，不要生成报告。`, { cancel: true });
  const pid = Number((await readFile(pidFile, 'utf8')).trim());
  assert.ok(Number.isInteger(pid) && pid > 1);
  let live = true;
  try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') live = false; else throw error; }
  // A short-lived zombie is also terminated; /proc state avoids treating it as an executing child.
  if (live) { const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => ''); live = !!stat && !/\) Z /.test(stat); }
  assert.equal(live, false, 'Canceled tool child must not remain running');
  evidence.checks.push('cancel', 'child-process-termination');
  const invalid = new PiAgentProvider({ enabled: true, piPath: config.AGENT_PI_PATH,
    workingDirectory: config.AGENT_PI_WORKING_DIRECTORY, agentDirectory: config.AGENT_PI_AGENT_DIRECTORY,
    modelProvider: config.AGENT_PI_MODEL_PROVIDER, model: `nonexistent-acceptance-${randomUUID()}` });
  try {
    const failed = await invalid.start({ runId: randomUUID(), prompt: 'reply OK', maxTurns: 1 },
      { event: async () => {}, session: async () => {}, reportDecision: async () => {} });
    const timer = setTimeout(() => { void failed.cancel(); }, 20_000);
    try { assert.equal((await failed.completion).status, 'failed'); } finally { clearTimeout(timer); }
  } finally { await invalid.shutdown(); }
  evidence.checks.push('invalid-model-fails');
  evidence.status = 'passed'; evidence.finishedAt = new Date().toISOString(); await save();
  console.log(JSON.stringify(evidence));
} catch (error) {
  evidence.status = 'failed'; evidence.error = error.message; await save(); throw error;
} finally {
  // Cancel only tasks created by this invocation if an assertion/connection failed.
  for (const id of ownedRuns) {
    const detail = await request(`/api/agent/runs/${id}`).catch(() => null);
    if (detail && ['pending', 'running'].includes(detail.run.status)) await request(`/api/agent/runs/${id}/cancel`, {}).catch(() => {});
  }
  if (orchestrator) await orchestrator.shutdown();
  if (app) await app.close();
  if (pool) await pool.end();
}
