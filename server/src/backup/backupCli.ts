import 'dotenv/config';
import { createReadStream, createWriteStream } from 'node:fs';
import { cp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { Transform } from 'node:stream';
import mysql, { type RowDataPacket } from 'mysql2/promise';
import { loadConfig, type EnvConfig } from '../config.js';
import {
  readCurrentSnapshot,
  sha256File,
  validateManifest,
  type CurrentSnapshotPointer,
  type ResearchSnapshotManifest,
} from '../research/snapshotManifest.js';

interface BackupManifest {
  schemaVersion: 1;
  backupId: string;
  createdAt: string;
  database: {
    host: string;
    port: string;
    name: string;
    dumpPath: string;
    dumpBytes: number;
    dumpSha256: string;
  };
  researchSnapshot: {
    snapshotId: string;
    rowCount: number;
    maxDate: string;
    rootPath: string;
  };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const command = process.argv[2];
  const args = parseArgs(process.argv.slice(3));
  if (command === 'create') {
    console.log(JSON.stringify(await createBackup(config, args), null, 2));
    return;
  }
  if (command === 'verify') {
    console.log(JSON.stringify(await verifyBackup(config, args), null, 2));
    return;
  }
  if (command === 'restore-check') {
    console.log(JSON.stringify(await restoreCheckBackup(config, args), null, 2));
    return;
  }
  throw new Error(
    '用法：npm run backup:create -- [--root <path>]，'
    + 'npm run backup:verify -- --path <backupDir>，'
    + '或 npm run backup:restore-check -- --path <backupDir> --database <temp_db> --confirm-drop <temp_db>',
  );
}

async function createBackup(
  config: EnvConfig,
  args: Record<string, string>,
): Promise<BackupManifest> {
  const backupRoot = resolve(args.root ?? config.BACKUP_ROOT);
  const snapshotRoot = resolve(args.snapshotRoot ?? config.RESEARCH_SNAPSHOT_ROOT);
  const current = await readCurrentSnapshot(snapshotRoot);
  if (!current) throw new Error('尚未发布研究快照，不能创建完整备份');

  const backupId = args.id ?? `backup-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`;
  const backupDir = join(backupRoot, backupId);
  await mkdir(backupRoot, { recursive: true });
  await mkdir(backupDir, { recursive: false });

  const dumpPath = join(backupDir, `${config.DB_NAME}.sql`);
  await dumpMysql(config, dumpPath);
  const dumpStat = await stat(dumpPath);

  const snapshotBackupRoot = join(backupDir, 'research-snapshots');
  await mkdir(snapshotBackupRoot, { recursive: true });
  await cp(
    join(snapshotRoot, current.manifest.snapshotId),
    join(snapshotBackupRoot, current.manifest.snapshotId),
    { recursive: true, errorOnExist: true },
  );
  await cp(
    join(snapshotRoot, 'current.json'),
    join(snapshotBackupRoot, 'current.json'),
    { errorOnExist: true },
  );

  const manifest: BackupManifest = {
    schemaVersion: 1,
    backupId,
    createdAt: new Date().toISOString(),
    database: {
      host: config.DB_HOST,
      port: config.DB_PORT,
      name: config.DB_NAME,
      dumpPath: basename(dumpPath),
      dumpBytes: dumpStat.size,
      dumpSha256: await sha256File(dumpPath),
    },
    researchSnapshot: {
      snapshotId: current.manifest.snapshotId,
      rowCount: current.manifest.rowCount,
      maxDate: current.manifest.maxDate,
      rootPath: 'research-snapshots',
    },
  };
  await writeFile(
    join(backupDir, 'backup-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
  return manifest;
}

async function verifyBackup(
  config: EnvConfig,
  args: Record<string, string>,
): Promise<{
  status: 'validated';
  backupId: string;
  databaseDump: { bytes: number; sha256: string };
  researchSnapshot: { snapshotId: string; rowCount: number; files: number };
}> {
  const backupDir = resolve(args.path ?? args.root ?? config.BACKUP_ROOT);
  const manifest = JSON.parse(
    await readFile(join(backupDir, 'backup-manifest.json'), 'utf8'),
  ) as BackupManifest;
  if (manifest.schemaVersion !== 1) throw new Error('备份 manifest 版本不支持');

  const dumpPath = join(backupDir, manifest.database.dumpPath);
  const dumpStat = await stat(dumpPath);
  const dumpSha256 = await sha256File(dumpPath);
  if (dumpStat.size !== manifest.database.dumpBytes) throw new Error('MySQL dump 文件大小不一致');
  if (dumpSha256 !== manifest.database.dumpSha256) throw new Error('MySQL dump SHA-256 不一致');

  const snapshotRoot = join(backupDir, manifest.researchSnapshot.rootPath);
  const pointer = JSON.parse(
    await readFile(join(snapshotRoot, 'current.json'), 'utf8'),
  ) as CurrentSnapshotPointer;
  const snapshotManifest = JSON.parse(
    await readFile(join(snapshotRoot, pointer.snapshotId, 'manifest.json'), 'utf8'),
  ) as ResearchSnapshotManifest;
  validateManifest(pointer, snapshotManifest);
  if (snapshotManifest.snapshotId !== manifest.researchSnapshot.snapshotId) {
    throw new Error('备份记录的研究快照 ID 与 current.json 不一致');
  }
  if (snapshotManifest.rowCount !== manifest.researchSnapshot.rowCount) {
    throw new Error('备份记录的研究快照行数不一致');
  }
  for (const partition of snapshotManifest.partitions) {
    const path = join(snapshotRoot, snapshotManifest.snapshotId, partition.relativePath);
    const fileStat = await stat(path);
    if (fileStat.size !== partition.bytes) throw new Error(`${partition.relativePath} 文件大小不一致`);
    const checksum = await sha256File(path);
    if (checksum !== partition.sha256) throw new Error(`${partition.relativePath} SHA-256 不一致`);
  }
  return {
    status: 'validated',
    backupId: manifest.backupId,
    databaseDump: { bytes: dumpStat.size, sha256: dumpSha256 },
    researchSnapshot: {
      snapshotId: snapshotManifest.snapshotId,
      rowCount: snapshotManifest.rowCount,
      files: snapshotManifest.partitions.length,
    },
  };
}

async function restoreCheckBackup(
  config: EnvConfig,
  args: Record<string, string>,
): Promise<{
  status: 'restored';
  backupId: string;
  database: string;
  cleanup: boolean;
  restored: { rowCount: number; maxDate: string | null };
  researchSnapshot: { snapshotId: string; rowCount: number; maxDate: string };
}> {
  const verified = await verifyBackup(config, args);
  const backupDir = resolve(args.path ?? args.root ?? config.BACKUP_ROOT);
  const manifest = JSON.parse(
    await readFile(join(backupDir, 'backup-manifest.json'), 'utf8'),
  ) as BackupManifest;
  const database = args.database ?? `${config.DB_NAME}_restore_check`;
  assertRestoreDatabaseName(database);
  const cleanup = args.cleanup === 'true';

  if (args['confirm-drop'] !== database) {
    throw new Error(`恢复演练会重建临时库 ${database}，请追加 --confirm-drop ${database}`);
  }

  const dumpPath = join(backupDir, manifest.database.dumpPath);
  await executeMysqlAdmin(config, `DROP DATABASE IF EXISTS \`${database}\``);
  await executeMysqlAdmin(
    config,
    `CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  );

  try {
    await importMysqlDump(config, database, dumpPath);
    const restored = await readRestoredSummary(config, database);
    if (restored.rowCount !== manifest.researchSnapshot.rowCount) {
      throw new Error(
        `恢复库 daily_bars_v2 行数不一致：restore=${restored.rowCount}, backup=${manifest.researchSnapshot.rowCount}`,
      );
    }
    if (restored.maxDate !== manifest.researchSnapshot.maxDate) {
      throw new Error(
        `恢复库 daily_bars_v2 最大交易日不一致：restore=${restored.maxDate}, backup=${manifest.researchSnapshot.maxDate}`,
      );
    }
    return {
      status: 'restored',
      backupId: verified.backupId,
      database,
      cleanup,
      restored,
      researchSnapshot: {
        snapshotId: manifest.researchSnapshot.snapshotId,
        rowCount: manifest.researchSnapshot.rowCount,
        maxDate: manifest.researchSnapshot.maxDate,
      },
    };
  } finally {
    if (cleanup) {
      await executeMysqlAdmin(config, `DROP DATABASE IF EXISTS \`${database}\``);
    }
  }
}

async function dumpMysql(config: EnvConfig, outputPath: string): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });
  const args = [
    `--host=${config.DB_HOST}`,
    `--port=${config.DB_PORT}`,
    `--user=${config.DB_USER}`,
    '--single-transaction',
    '--quick',
    '--routines',
    '--triggers',
    '--events',
    '--hex-blob',
    '--default-character-set=utf8mb4',
    '--set-gtid-purged=OFF',
    config.DB_NAME,
  ];
  const child = spawn('mysqldump', args, {
    env: { ...process.env, MYSQL_PWD: config.DB_PASSWORD },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = createWriteStream(outputPath);
  const stderrChunks: Buffer[] = [];
  const outputFinished = new Promise<void>((resolveFinished, reject) => {
    output.on('finish', resolveFinished);
    output.on('error', reject);
  });
  child.stdout.pipe(output);
  child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
  const exitCode = await new Promise<number | null>((resolveCode, reject) => {
    child.on('error', reject);
    child.on('close', resolveCode);
  });
  await outputFinished;
  if (exitCode !== 0) {
    const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
    throw new Error(`mysqldump 失败，退出码 ${exitCode}${stderr ? `：${stderr}` : ''}`);
  }
}

async function importMysqlDump(
  config: EnvConfig,
  database: string,
  dumpPath: string,
): Promise<void> {
  const args = [
    `--host=${config.DB_HOST}`,
    `--port=${config.DB_PORT}`,
    `--user=${config.DB_USER}`,
    '--default-character-set=utf8mb4',
    database,
  ];
  const child = spawn('mysql', args, {
    env: { ...process.env, MYSQL_PWD: config.DB_PASSWORD },
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  const input = createReadStream(dumpPath).pipe(stripInstanceLevelRestoreStatements());
  const stderrChunks: Buffer[] = [];
  child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
  child.on('close', () => {
    input.destroy();
  });
  input.pipe(child.stdin);
  const exitCode = await new Promise<number | null>((resolveCode, reject) => {
    child.on('error', reject);
    child.on('close', resolveCode);
    input.on('error', reject);
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE') reject(error);
    });
  });
  if (exitCode !== 0) {
    const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
    throw new Error(`mysql 导入备份失败，退出码 ${exitCode}${stderr ? `：${stderr}` : ''}`);
  }
}

function stripInstanceLevelRestoreStatements(): Transform {
  let pending = '';
  return new Transform({
    transform(chunk, _encoding, callback) {
      pending += chunk.toString('utf8');
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      callback(null, lines.filter(shouldKeepRestoreLine).join('\n') + '\n');
    },
    flush(callback) {
      if (pending && shouldKeepRestoreLine(pending)) this.push(pending);
      callback();
    },
  });
}

function shouldKeepRestoreLine(line: string): boolean {
  return !line.includes('@@GLOBAL.GTID_PURGED');
}

async function executeMysqlAdmin(config: EnvConfig, sql: string): Promise<void> {
  const connection = await mysql.createConnection({
    host: config.DB_HOST,
    port: parseInt(config.DB_PORT, 10),
    user: config.DB_USER,
    password: config.DB_PASSWORD,
    charset: 'utf8mb4',
    multipleStatements: false,
  });
  try {
    await connection.query(sql);
  } finally {
    await connection.end();
  }
}

interface RestoredSummaryRow extends RowDataPacket {
  rowsCount: number | string;
  maxDate: string | null;
}

async function readRestoredSummary(
  config: EnvConfig,
  database: string,
): Promise<{ rowCount: number; maxDate: string | null }> {
  const connection = await mysql.createConnection({
    host: config.DB_HOST,
    port: parseInt(config.DB_PORT, 10),
    user: config.DB_USER,
    password: config.DB_PASSWORD,
    database,
    charset: 'utf8mb4',
  });
  try {
    const [rows] = await connection.query<RestoredSummaryRow[]>(`
      SELECT COUNT(*) AS rowsCount,
             DATE_FORMAT(MAX(trade_date), '%Y-%m-%d') AS maxDate
      FROM daily_bars_v2
    `);
    return {
      rowCount: Number(rows[0]?.rowsCount ?? 0),
      maxDate: rows[0]?.maxDate ?? null,
    };
  } finally {
    await connection.end();
  }
}

function assertRestoreDatabaseName(database: string): void {
  if (!/^[A-Za-z0-9_]+$/.test(database)) {
    throw new Error('恢复演练库名只能包含字母、数字和下划线');
  }
  if (!database.endsWith('_restore_check')) {
    throw new Error('恢复演练库名必须以 _restore_check 结尾，避免误删正式库');
  }
}

function parseArgs(args: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2);
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`参数 ${item} 缺少值`);
    result[key] = value;
    index += 1;
  }
  return result;
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
