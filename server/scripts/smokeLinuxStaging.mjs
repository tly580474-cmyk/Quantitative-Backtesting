// Read-only acceptance of the full-data secondary server.
import 'dotenv/config';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import mysql from 'mysql2/promise';

assert.equal(process.platform, 'linux');
assert.equal(process.env.BACKGROUND_JOBS_ENABLED, 'false');
const root = '/var/lib/quant-migration';
const credentials = await readFile('/root/quant-staging-access.txt', 'utf8');
const password = credentials.match(/^Gateway password: (.+)$/m)[1];
const basic = `Basic ${Buffer.from(`quant:${password}`).toString('base64')}`;
const bearer = `Bearer ${process.env.ADMIN_API_TOKEN}`;
const manifest = JSON.parse(await readFile(`${root}/source-database-manifest.json`, 'utf8'));
const results = [];
async function request(port, path, authorization) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: authorization ? { Authorization: authorization } : {}, signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, data };
}
async function check(name, run) {
  await run(); results.push({ name, passed: true }); console.log(`PASS ${name}`);
}
await check('frontend requires authentication', async () => {
  assert.equal((await request(8080, '/')).status, 401);
});
await check('frontend and management static pages', async () => {
  for (const port of [8080, 8081]) assert.equal((await request(port, '/', basic)).status, 200);
});
await check('database connected and full instrument inventory', async () => {
  assert.equal((await request(8080, '/api/health', basic)).data.db, 'connected');
  const response = await request(8080, '/api/instruments?limit=5', basic);
  assert.equal(response.status, 200); assert.equal(response.data.total, manifest.before.instruments);
  const instrument = response.data.items.find(item => item.recordCount > 0);
  assert.ok(instrument);
  const candles = await request(8080, `/api/instruments/${instrument.id}/candles?limit=5&adjustmentMode=none`, basic);
  assert.equal(candles.status, 200); assert.equal(candles.data.items.length, 5);
  assert.equal(candles.data.storage, 'history-v2');
});
await check('admin API access separation', async () => {
  assert.equal((await request(8080, '/api/admin/health', basic)).status, 403);
  assert.equal((await request(8081, '/api/admin/health')).status, 401);
  assert.equal((await request(8081, '/api/admin/health', bearer)).status, 200);
});
await check('published research snapshot', async () => {
  assert.equal((await request(8080, '/api/research-snapshots/current', basic)).status, 200);
});
await check('historical report download and agent history', async () => {
  const paths = JSON.parse(await readFile(`${root}/path-remapping.json`, 'utf8'));
  const report = paths.find(item => item.table === 'agent_reports' && item.destinationExists);
  assert.ok(report);
  const id = basename(report.destination, '.html');
  const response = await request(8080, `/api/agent/reports/${id}/download`, basic);
  assert.equal(response.status, 200); assert.match(response.data, /<html|<!doctype/i);
  assert.equal((await request(8080, '/api/agent/conversations', basic)).status, 200);
  assert.equal((await request(8080, '/api/agent/providers', basic)).status, 200);
});
await check('all migrated attachment bytes match database hashes', async () => {
  const c = await mysql.createConnection({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME });
  try {
    const [rows] = await c.query('SELECT stored_path,sha256 FROM agent_attachments');
    assert.equal(rows.length, manifest.before.agent_attachments);
    for (const row of rows) {
      const digest = createHash('sha256').update(await readFile(row.stored_path)).digest('hex');
      assert.equal(digest, row.sha256);
    }
    const [[event]] = await c.query('SELECT @@GLOBAL.event_scheduler AS value');
    assert.equal(event.value, 'OFF');
  } finally { await c.end(); }
});
await check('all OS update timers remain inactive', async () => {
  for (const job of ['research', 'minute', 'fund-flow', 'tdx-shadow']) {
    const status = execFileSync('systemctl', ['show', `quant-job@${job}.timer`, '--property=ActiveState', '--value'], { encoding: 'utf8' }).trim();
    assert.equal(status, 'inactive');
  }
});
await writeFile(`${root}/staging-smoke.json`, JSON.stringify({ checkedAt: new Date().toISOString(), results }, null, 2));
