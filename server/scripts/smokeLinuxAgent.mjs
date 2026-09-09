import 'dotenv/config';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
assert.equal(process.env.QUANT_TEST_MODE, 'true');
const password = (await readFile('/root/quant-test-access.txt', 'utf8')).match(/^Gateway password: (.+)$/m)[1];
const authorization = `Basic ${Buffer.from(`quant:${password}`).toString('base64')}`;
const base = 'http://127.0.0.1:8080';
async function post(path, body) {
  const response = await fetch(base + path, { method: 'POST', headers: { Authorization: authorization, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json(); assert.ok(response.ok, JSON.stringify(data)); return data;
}
const form = new FormData();
form.append('file', new Blob(['Linux synthetic attachment: three sample stocks, 180 daily bars.']), 'linux-smoke.txt');
const upload = await fetch(base + '/api/agent/attachments', { method: 'POST', headers: { Authorization: authorization }, body: form });
const attachment = await upload.json(); assert.ok(upload.ok, JSON.stringify(attachment));
for (const provider of ['codex', 'claude']) {
  const run = await post('/api/agent/runs', { provider, prompt: '这是 Ubuntu 适配测试，请简短确认你已收到这条测试消息。不需要读取文件、执行工具或生成报告。',
    ...(provider === 'codex' ? { attachmentIds: [attachment.attachment.id] } : {}) });
  const response = await fetch(base + `/api/agent/runs/${run.runId}/stream`, { headers: { Authorization: authorization }, signal: AbortSignal.timeout(90_000) });
  assert.equal(response.status, 200);
  let output = ''; let firstChunk = true;
  for await (const chunk of response.body) {
    const text = new TextDecoder().decode(chunk);
    if (firstChunk) { assert.ok(text.includes(': connected')); firstChunk = false; }
    output += text;
  }
  const events = output.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
  assert.ok(events.some(event => event.type === 'assistant_final'));
  assert.ok(events.some(event => event.terminal?.status === 'completed'), JSON.stringify(events.filter(event => event.type === 'error' || event.terminal)));
  console.log(`PASS ${provider}: HTTP run, SSE streaming, persistence${provider === 'codex' ? ', attachment' : ''}; runId=${run.runId}`);
}
