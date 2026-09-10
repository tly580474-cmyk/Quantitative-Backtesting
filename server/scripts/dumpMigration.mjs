// Read-only source backup: InnoDB consistent snapshot, streamed to compressed disk file.
import 'dotenv/config';
import mysql from 'mysql2/promise';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';

const output = resolve(process.argv[2]);
await mkdir(output, { recursive: true });
const config = { host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '', database: process.env.DB_NAME || 'quant_backtest' };
const db = await mysql.createConnection(config);
try {
  const [[version]] = await db.query('SELECT VERSION() version');
  const [tables] = await db.query('SELECT table_name name,engine FROM information_schema.tables WHERE table_schema=DATABASE() AND table_type=\'BASE TABLE\' ORDER BY table_name');
  if (tables.some(table => table.ENGINE !== 'InnoDB' && table.engine !== 'InnoDB')) throw new Error('Nontransactional tables require a separate consistency plan');
  async function counts() {
    const result = {};
    for (const table of tables) {
      const name = table.name ?? table.NAME;
      const [[row]] = await db.query('SELECT COUNT(*) n FROM `' + name.replaceAll('`', '``') + '`');
      result[name] = Number(row.n);
    }
    return result;
  }
  console.log('Counting source tables before consistent snapshot');
  const before = await counts();
  const startedAt = new Date().toISOString();
  await writeFile(resolve(output, 'source-before.json'), JSON.stringify({ version, startedAt, counts: before }, null, 2));
  const args = [`--host=${config.host}`, `--port=${config.port}`, `--user=${config.user}`,
    '--single-transaction', '--quick', '--routines', '--events', '--triggers', '--hex-blob',
    '--no-tablespaces', '--set-gtid-purged=OFF', '--column-statistics=0', '--default-character-set=utf8mb4', config.database];
  const child = spawn('mysqldump', args, { env: { ...process.env, MYSQL_PWD: config.password }, stdio: ['ignore', 'pipe', 'pipe'] });
  let error = '';
  child.stderr.on('data', chunk => { error += chunk; });
  const ended = new Promise((resolveCode, reject) => { child.once('error', reject); child.once('close', resolveCode); });
  await pipeline(child.stdout, createGzip({ level: 1 }), createWriteStream(resolve(output, 'database.sql.gz.partial')));
  if (await ended !== 0) throw new Error(error);
  await rename(resolve(output, 'database.sql.gz.partial'), resolve(output, 'database.sql.gz'));
  const after = await counts();
  const changedTables = Object.keys(before).filter(name => before[name] !== after[name]);
  await writeFile(resolve(output, 'source-database-manifest.json'), JSON.stringify({ database: config.database,
    version, startedAt, finishedAt: new Date().toISOString(), before, after, changedTables }, null, 2));
  console.log(JSON.stringify({ finished: true, tables: tables.length, changedTables }));
} finally { await db.end(); }
