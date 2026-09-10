// Destination-only path conversion; raw dump and transfer manifests stay unchanged.
import 'dotenv/config';
import assert from 'node:assert/strict';
import { readFile, writeFile, access } from 'node:fs/promises';
import mysql from 'mysql2/promise';

assert.equal(process.platform, 'linux');
assert.equal(process.cwd(), '/opt/quant-backtest/server');
assert.equal(process.env.BACKGROUND_JOBS_ENABLED, 'false');
const root = '/var/lib/quant-migration';
const refs = JSON.parse(await readFile(`${root}/source-file-references.json`, 'utf8'));
function remap(value) {
  const normalized = value.replaceAll('\\', '/');
  const prefix = 'D:/github_public_repo/量化回测/';
  return normalized.toLowerCase().startsWith(prefix.toLowerCase())
    ? '/opt/quant-backtest/' + normalized.slice(prefix.length) : value;
}
const c = await mysql.createConnection({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME });
const result = [];
try {
  await c.beginTransaction();
  for (const reference of refs) {
    const { table, column, path: original } = reference;
    assert.match(table, /^\w+$/); assert.match(column, /^\w+$/);
    const destination = remap(original);
    const exists = await access(destination).then(() => true, () => false);
    if (reference.sourceExists) assert.ok(exists, `Missing copied artifact: ${destination}`);
    const [updated] = await c.execute(`UPDATE \`${table}\` SET \`${column}\`=? WHERE \`${column}\`=?`, [destination, original]);
    result.push({ ...reference, destination, destinationExists: exists, changedRows: updated.affectedRows });
  }
  await c.commit();
  await writeFile(`${root}/path-remapping.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ references: result.length, changedRows: result.reduce((sum, row) => sum + row.changedRows, 0),
    preExistingMissing: result.filter(row => !row.sourceExists).length }));
} catch (error) { await c.rollback(); throw error; }
finally { await c.end(); }
