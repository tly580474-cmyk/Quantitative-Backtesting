// Run before starting the destination app. This script never changes the database.
import 'dotenv/config';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import mysql from 'mysql2/promise';

assert.equal(process.platform, 'linux');
assert.equal(process.env.BACKGROUND_JOBS_ENABLED, 'false');
const root = '/var/lib/quant-migration';
const manifest = JSON.parse(await readFile(`${root}/source-database-manifest.json`, 'utf8'));
const connection = await mysql.createConnection({
  host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
});
try {
  const [tables] = await connection.query('SHOW FULL TABLES WHERE Table_type = "BASE TABLE"');
  assert.deepEqual(tables.map(row => Object.values(row)[0]).sort(), Object.keys(manifest.before).sort());
  const results = [];
  for (const table of Object.keys(manifest.before).sort()) {
    assert.match(table, /^\w+$/);
    const [[row]] = await connection.query(`SELECT COUNT(*) AS n FROM \`${table}\``);
    const before = Number(manifest.before[table]), after = Number(manifest.after[table]);
    const count = Number(row.n);
    const passed = before === after ? count === before : count >= Math.min(before, after) && count <= Math.max(before, after);
    results.push({ table, before, after, destination: count, stableDuringDump: before === after, passed });
    console.log(`${passed ? 'PASS' : 'FAIL'} ${table}: ${count} (${before} -> ${after})`);
  }
  const [[version]] = await connection.query('SELECT VERSION() AS version');
  await writeFile(`${root}/database-verification.json`, JSON.stringify({ checkedAt: new Date().toISOString(), version, results }, null, 2));
  assert.ok(results.every(result => result.passed), 'Destination row counts differ from source dump interval');
} finally { await connection.end(); }
