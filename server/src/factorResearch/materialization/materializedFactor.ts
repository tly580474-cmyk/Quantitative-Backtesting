import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { readCurrentSnapshot } from '../../research/snapshotManifest.js';

export interface MaterializedFactorManifest {
  schemaVersion: 1;
  status: 'validated';
  candidateId: string;
  snapshotId: string;
  formulaChecksum: string;
  startDate: string;
  endDate: string;
  rowCount: number;
  validValueCount: number;
  backend: string;
  elapsedSeconds: number;
  partitions: Array<{ year: number; relativePath: string; rows: number; sha256: string }>;
}

export async function ensureMaterializedFactor(options: {
  candidateId: string;
  prefix: string;
  warmupDays: number;
  startDate: string;
  endDate: string;
  snapshotRoot: string;
  artifactRoot: string;
  minerRoot: string;
  pythonExecutable: string;
  timeoutMs: number;
}): Promise<{ parquetGlob: string; manifest: MaterializedFactorManifest }> {
  const current = await readCurrentSnapshot(resolve(options.snapshotRoot));
  if (!current) throw new Error('尚未发布可用的研究快照');
  const checksum = createHash('sha256').update(options.prefix).digest('hex');
  const outputRoot = resolve(options.artifactRoot, 'factor-values',
    `snapshot=${current.manifest.snapshotId}`, `factor=${options.candidateId}`);
  const cached = await readValidManifest(outputRoot, {
    candidateId: options.candidateId, snapshotId: current.manifest.snapshotId,
    formulaChecksum: checksum, startDate: options.startDate, endDate: options.endDate,
  });
  if (cached) return { parquetGlob: normalizePath(join(outputRoot, 'year=*', '*.parquet')), manifest: cached };

  await mkdir(resolve(outputRoot, '..'), { recursive: true });
  const configPath = `${outputRoot}.config.json`;
  await writeFile(configPath, `${JSON.stringify({
    candidate_id: options.candidateId,
    prefix: options.prefix,
    warmup_days: options.warmupDays,
    start_date: options.startDate,
    end_date: options.endDate,
    snapshot_root: resolve(options.snapshotRoot),
    snapshot_id: current.manifest.snapshotId,
    formula_checksum: checksum,
  }, null, 2)}\n`, 'utf8');
  try {
    await runMaterializer(options.pythonExecutable,
      resolve(options.minerRoot, 'materialize_factor.py'), configPath, outputRoot, options.timeoutMs);
  } finally {
    // 配置不含密钥，但删除可避免长期堆积一次性任务文件。
    await unlink(configPath).catch(() => undefined);
  }
  // 进程成功退出后仍校验完整产物，避免把半成品交给 DuckDB。
  const manifest = await readValidManifest(outputRoot, {
    candidateId: options.candidateId, snapshotId: current.manifest.snapshotId,
    formulaChecksum: checksum, startDate: options.startDate, endDate: options.endDate,
  });
  if (!manifest) throw new Error('因子物化完成但 manifest 校验失败');
  return { parquetGlob: normalizePath(join(outputRoot, 'year=*', '*.parquet')), manifest };
}

async function readValidManifest(root: string, expected: {
  candidateId: string; snapshotId: string; formulaChecksum: string; startDate: string; endDate: string;
}): Promise<MaterializedFactorManifest | null> {
  try {
    const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as MaterializedFactorManifest;
    if (manifest.schemaVersion !== 1 || manifest.status !== 'validated'
      || manifest.candidateId !== expected.candidateId || manifest.snapshotId !== expected.snapshotId
      || manifest.formulaChecksum !== expected.formulaChecksum
      || manifest.startDate !== expected.startDate || manifest.endDate !== expected.endDate
      || manifest.rowCount <= 0 || manifest.validValueCount <= 0 || !manifest.partitions.length) return null;
    await Promise.all(manifest.partitions.map((item) => access(resolve(root, item.relativePath))));
    return manifest;
  } catch {
    return null;
  }
}

function runMaterializer(
  python: string, script: string, configPath: string, outputRoot: string, timeoutMs: number,
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(python, [script, '--config', configPath, '--output', outputRoot], {
      cwd: dirname(script), windowsHide: true,
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    });
    let output = '';
    let settled = false;
    const consume = (chunk: Buffer) => { output = (output + chunk.toString('utf8')).slice(-20_000); };
    child.stdout.on('data', consume);
    child.stderr.on('data', consume);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`因子物化超过最大运行时间（${Math.round(timeoutMs / 60000)} 分钟）`));
    }, Math.max(60_000, timeoutMs));
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    // Windows 下 close 还会等待所有继承的管道句柄关闭；进程已经退出时可能长时间不触发。
    child.once('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolvePromise();
      else reject(new Error(`因子物化进程退出码 ${code}：${output.slice(-4000)}`));
    });
  });
}

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/');
}
