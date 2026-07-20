import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import type { EnvConfig } from '../config.js';

export interface DatabaseBackupExportStatus {
  id: string;
  status: 'idle' | 'running' | 'completed' | 'failed';
  createdAt: string | null;
  startedAt: string | null;
  updatedAt: string;
  finishedAt: string | null;
  fileName: string | null;
  bytes: number | null;
  sha256: string | null;
  error: string | null;
}

interface ExportDependencies {
  dump?: (config: EnvConfig, outputPath: string) => Promise<void>;
  now?: () => Date;
}

let activeExport: Promise<void> | null = null;
let cachedStatus: { path: string; value: DatabaseBackupExportStatus } | null = null;

export async function startDatabaseBackupExport(
  config: EnvConfig,
  dependencies: ExportDependencies = {},
): Promise<DatabaseBackupExportStatus> {
  const current = await getDatabaseBackupExportStatus(config);
  if (activeExport || current.status === 'running') throw new Error('已有数据库备份正在导出');
  const now = dependencies.now?.() ?? new Date();
  const id = `database-${now.toISOString().replace(/\D/g, '').slice(0, 14)}-${process.pid}`;
  const root = exportRoot(config);
  const fileName = `${id}.sql`;
  const finalPath = join(root, fileName);
  const partialPath = `${finalPath}.partial`;
  const initial: DatabaseBackupExportStatus = {
    id,
    status: 'running',
    createdAt: now.toISOString(),
    startedAt: now.toISOString(),
    updatedAt: now.toISOString(),
    finishedAt: null,
    fileName: null,
    bytes: null,
    sha256: null,
    error: null,
  };
  await mkdir(root, { recursive: true });
  await writeStatus(config, initial);
  activeExport = (async () => {
    try {
      await (dependencies.dump ?? dumpMysqlDatabase)(config, partialPath);
      const fileStat = await stat(partialPath);
      if (fileStat.size <= 0) throw new Error('mysqldump 生成了空文件');
      const sha256 = await sha256File(partialPath);
      await rename(partialPath, finalPath);
      const finishedAt = (dependencies.now?.() ?? new Date()).toISOString();
      await writeStatus(config, {
        ...initial, status: 'completed', updatedAt: finishedAt, finishedAt,
        fileName, bytes: fileStat.size, sha256,
      });
    } catch (error) {
      await unlink(partialPath).catch(() => undefined);
      const finishedAt = (dependencies.now?.() ?? new Date()).toISOString();
      await writeStatus(config, {
        ...initial, status: 'failed', updatedAt: finishedAt, finishedAt,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      activeExport = null;
    }
  })();
  void activeExport;
  return initial;
}

export async function getDatabaseBackupExportStatus(config: EnvConfig): Promise<DatabaseBackupExportStatus> {
  const currentStatusPath = statusPath(config);
  if (cachedStatus?.path === currentStatusPath) return cachedStatus.value;
  try {
    const parsed = JSON.parse((await readFile(currentStatusPath, 'utf8')).replace(/^\uFEFF/, '')) as DatabaseBackupExportStatus;
    if (parsed.status === 'running' && !activeExport) {
      const now = new Date().toISOString();
      const interrupted = { ...parsed, status: 'failed' as const, updatedAt: now, finishedAt: now, error: '后端重启导致备份导出中断，请重新导出' };
      await writeStatus(config, interrupted);
      return interrupted;
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return idleStatus();
  }
}

export async function resolveDatabaseBackupDownload(
  config: EnvConfig,
  id: string,
): Promise<{ path: string; fileName: string; bytes: number; sha256: string }> {
  const status = await getDatabaseBackupExportStatus(config);
  if (status.status !== 'completed' || status.id !== id || !status.fileName || !status.sha256) {
    throw new Error('数据库备份尚未完成或已不可用');
  }
  if (basename(status.fileName) !== status.fileName || !/^database-\d{14}-\d+\.sql$/.test(status.fileName)) {
    throw new Error('数据库备份文件名无效');
  }
  const path = join(exportRoot(config), status.fileName);
  const fileStat = await stat(path);
  if (status.bytes !== fileStat.size) throw new Error('数据库备份文件大小校验失败');
  return { path, fileName: status.fileName, bytes: fileStat.size, sha256: status.sha256 };
}

async function dumpMysqlDatabase(config: EnvConfig, outputPath: string): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });
  const args = [
    `--host=${config.DB_HOST}`, `--port=${config.DB_PORT}`, `--user=${config.DB_USER}`,
    '--single-transaction', '--quick', '--routines', '--triggers', '--events', '--hex-blob',
    '--default-character-set=utf8mb4', '--set-gtid-purged=OFF', config.DB_NAME,
  ];
  const child = spawn('mysqldump', args, {
    env: { ...process.env, MYSQL_PWD: config.DB_PASSWORD },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const output = createWriteStream(outputPath, { flags: 'wx' });
  const stderrChunks: Buffer[] = [];
  child.stdout.pipe(output);
  child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
  const [exitCode] = await Promise.all([
    new Promise<number | null>((resolveCode, reject) => {
      child.on('error', reject);
      child.on('close', resolveCode);
    }),
    new Promise<void>((resolveFinished, reject) => {
      output.on('finish', resolveFinished);
      output.on('error', reject);
    }),
  ]);
  if (exitCode !== 0) {
    const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
    throw new Error(`mysqldump 失败，退出码 ${exitCode}${stderr ? `：${stderr}` : ''}`);
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function writeStatus(config: EnvConfig, value: DatabaseBackupExportStatus): Promise<void> {
  const path = statusPath(config);
  cachedStatus = { path, value };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function exportRoot(config: EnvConfig): string {
  return resolve(config.BACKUP_ROOT, 'admin-database-exports');
}

function statusPath(config: EnvConfig): string {
  return join(exportRoot(config), 'latest.json');
}

function idleStatus(): DatabaseBackupExportStatus {
  return { id: '', status: 'idle', createdAt: null, startedAt: null, updatedAt: new Date().toISOString(), finishedAt: null, fileName: null, bytes: null, sha256: null, error: null };
}
