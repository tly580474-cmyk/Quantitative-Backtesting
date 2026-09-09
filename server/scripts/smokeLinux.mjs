import 'dotenv/config';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

assert.equal(process.env.QUANT_TEST_MODE, 'true');
const credentials = await readFile('/root/quant-test-access.txt', 'utf8');
const password = credentials.match(/^Gateway password: (.+)$/m)[1];
const basic = `Basic ${Buffer.from(`quant:${password}`).toString('base64')}`;
const bearer = `Bearer ${process.env.ADMIN_API_TOKEN}`;
const results = [];
async function request(port, path, authorization, method = 'GET', body) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { method,
    headers: { ...(authorization ? { Authorization: authorization } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30_000) });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, data };
}
async function check(name, run) { await run(); results.push({ name, passed: true }); console.log(`PASS ${name}`); }
// systemd Type=simple reports active before Node finishes migrations/listening.
await check('backend readiness', async () => {
  for (let i = 0; i < 40; i++) {
    try { if ((await request(8080, '/api/health', basic)).data.db === 'connected') return; } catch {}
    await sleep(500);
  }
  assert.fail('Backend did not become ready within 20 seconds');
});
await check('gateway requires login', async () => assert.equal((await request(8080, '/')).status, 401));
await check('frontend and management static pages', async () => {
  for (const port of [8080, 8081]) assert.equal((await request(port, '/', basic)).status, 200);
});
await check('same-origin health and sample instruments', async () => {
  assert.equal((await request(8080, '/api/health', basic)).data.db, 'connected');
  const list = await request(8080, '/api/instruments', basic);
  assert.equal(list.status, 200); assert.equal(list.data.total, 3);
  assert.equal(list.data.items[0].recordCount, 60);
});
await check('public gateway blocks admin API', async () => assert.equal((await request(8080, '/api/admin/health', basic)).status, 403));
await check('management API rejects missing token', async () => assert.equal((await request(8081, '/api/admin/health')).status, 401));
await check('management health and snapshot API', async () => {
  assert.equal((await request(8081, '/api/admin/health', bearer)).status, 200);
  assert.equal((await request(8080, '/api/research-snapshots/current', basic)).status, 200);
});
await check('public switch leaves management reachable and restores frontend', async () => {
  try {
    assert.equal((await request(8081, '/api/admin/public-access', bearer, 'PUT', { enabled: false })).status, 200);
    assert.equal((await request(8081, '/api/admin/public-access', bearer)).data.enabled, false);
    await assert.rejects(() => request(8080, '/', basic));
  } finally {
    assert.equal((await request(8081, '/api/admin/public-access', bearer, 'PUT', { enabled: true })).status, 200);
  }
  assert.equal((await request(8080, '/', basic)).status, 200);
});
await check('backend restart recovers under systemd', async () => {
  assert.equal((await request(8081, '/api/admin/restart/status', bearer)).data.available, true);
  const result = await request(8081, '/api/admin/restart', bearer, 'POST', {});
  assert.ok([200, 202].includes(result.status));
  await sleep(1500);
  let recovered = false;
  for (let i = 0; i < 30; i++) {
    try { recovered = (await request(8080, '/api/health', basic)).data.db === 'connected'; } catch {}
    if (recovered) break;
    await sleep(500);
  }
  assert.ok(recovered);
});
await writeFile('/tmp/quant-smoke-results.json', JSON.stringify(results, null, 2));
