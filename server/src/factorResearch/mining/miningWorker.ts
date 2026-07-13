import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  createFactorCandidate, getMiningTask, updateMiningTask,
} from '../candidates/candidateRepository.js';
import type { AstFactorExpression, FactorDirection } from '../definitions/schema.js';

export interface MiningWorkerOptions {
  pythonExecutable: string;
  minerRoot: string;
  snapshotRoot: string;
  artifactRoot: string;
  timeoutMs: number;
  maxMemoryMb: number;
}

interface ActiveWorker { child: ChildProcessWithoutNullStreams; timeout: NodeJS.Timeout; canceled: boolean }
const ACTIVE = new Map<string, ActiveWorker>();
const AST_TERMINALS = ['open', 'high', 'low', 'close', 'volume', 'amount', 'vwap',
  'turnover', 'returns', 'log_mktcap'];
const AST_FUNCTIONS = ['add', 'sub', 'mul', 'div', 'min', 'max', 'neg', 'abs', 'log',
  'sqrt', 'sign', 'inv', 'cs_rank', 'cs_zscore', 'cs_neutralize', 'cs_indneutral',
  'ts_delay', 'ts_delta', 'ts_mean', 'ts_std', 'ts_min', 'ts_max', 'ts_sum'];

export async function startMiningWorker(taskId: string, options: MiningWorkerOptions, resume = false) {
  if (ACTIVE.has(taskId)) throw new Error('挖掘任务已经在运行');
  const task = await getMiningTask(taskId);
  if (!task) throw new Error('挖掘任务不存在');
  if (!['pending', 'failed', 'canceled'].includes(task.status)) {
    throw new Error(`当前任务状态 ${task.status} 不允许启动`);
  }
  const minerRoot = resolve(options.minerRoot);
  const taskRoot = resolve(options.artifactRoot, 'mining', 'tasks', taskId);
  const outputRoot = join(taskRoot, 'output');
  await mkdir(outputRoot, { recursive: true });
  const taskConfig = buildWorkerConfig(task.config as Record<string, unknown>, {
    snapshotRoot: resolve(options.snapshotRoot), outputRoot,
    totalGenerations: Number(asRecord((task.config as Record<string, unknown>).evolution).generations
      ?? task.totalGenerations),
  });
  const requestedResources = asRecord((task.config as Record<string, unknown>).resources);
  const effectiveTimeoutMs = Math.min(options.timeoutMs,
    Math.max(60_000, Number(requestedResources.timeoutMs ?? options.timeoutMs)));
  const effectiveMemoryMb = Math.min(options.maxMemoryMb,
    Math.max(256, Number(requestedResources.maxMemoryMb ?? options.maxMemoryMb)));
  const configPath = join(taskRoot, 'config.json');
  await writeFile(configPath, `${JSON.stringify(taskConfig, null, 2)}\n`, 'utf8');
  const args = [join(minerRoot, 'worker_entry.py'), '--config', configPath, '--candidate-only'];
  if (resume) args.push('--resume');
  const child = spawn(options.pythonExecutable, args, {
    cwd: taskRoot, windowsHide: true,
    env: { ...process.env, PYTHONUNBUFFERED: '1',
      FACTOR_MINER_MAX_MEMORY_MB: String(effectiveMemoryMb) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const active: ActiveWorker = {
    child,
    canceled: false,
    timeout: setTimeout(() => terminateWorker(taskId, '任务超过最大运行时间'), effectiveTimeoutMs),
  };
  ACTIVE.set(taskId, active);
  await updateMiningTask(taskId, { status: 'running', startedAt: new Date().toISOString(),
    finishedAt: null, errorMessage: null, artifactUri: outputRoot, workerPid: child.pid ?? null });
  let logBuffer = '';
  let lineBuffer = '';
  let seedIndex = 1;
  const generationsPerSeed = Math.max(1, Number(
    asRecord(taskConfig.evolution).generations ?? task.totalGenerations));
  const consume = (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    logBuffer = (logBuffer + text).slice(-200_000);
    lineBuffer += text;
    const lines = lineBuffer.split(/\r?\n/);
    lineBuffer = lines.pop() ?? '';
    for (const line of lines) {
      const seedMatch = line.match(/随机种子\s+\d+（(\d+)\/(\d+)）/);
      if (seedMatch) {
        seedIndex = Math.max(1, Number(seedMatch[1]));
        const completedBeforeSeed = (seedIndex - 1) * generationsPerSeed;
        void updateMiningTask(taskId, {
          completedGenerations: Math.min(task.totalGenerations, completedBeforeSeed),
        });
      }
      const generationMatch = line.match(/Gen\s+(\d+)\s+\|/);
      if (!generationMatch) continue;
      const completed = (seedIndex - 1) * generationsPerSeed + Number(generationMatch[1]) + 1;
      void updateMiningTask(taskId, { completedGenerations: Math.min(task.totalGenerations, completed) });
    }
    // stdout/stderr 的 chunk 可能刚好不带换行；限制残片避免异常输出无限增长。
    if (lineBuffer.length > 16_384) {
      lineBuffer = lineBuffer.slice(-16_384);
    }
  };
  child.stdout.on('data', consume);
  child.stderr.on('data', consume);
  child.once('error', async (error) => {
    await finishFailed(taskId, `worker 启动失败：${error.message}`);
  });
  child.once('close', async (code) => {
    const state = ACTIVE.get(taskId);
    if (!state) return;
    clearTimeout(state.timeout);
    ACTIVE.delete(taskId);
    if (state.canceled) return;
    if (code !== 0) {
      const suffix = logBuffer.slice(-4000);
      await finishFailed(taskId, `worker 退出码 ${code}\n${suffix}`.slice(0, 1000));
      return;
    }
    try {
      const imported = await importWorkerCandidates(taskId, outputRoot);
      await updateMiningTask(taskId, { status: 'completed',
        completedGenerations: task.totalGenerations, finishedAt: new Date().toISOString(),
        errorMessage: null, workerPid: null });
      void imported;
    } catch (error) {
      await finishFailed(taskId, error instanceof Error ? error.message : String(error));
    }
  });
  return { taskId, pid: child.pid, taskRoot, outputRoot,
    resourceBudget: { timeoutMs: effectiveTimeoutMs, maxMemoryMb: effectiveMemoryMb } };
}

export async function cancelMiningWorker(taskId: string) {
  const active = ACTIVE.get(taskId);
  const task = await getMiningTask(taskId);
  if (!task || task.status !== 'running') return false;
  if (active) {
    active.canceled = true;
    clearTimeout(active.timeout);
    await killProcessTree(active.child);
    ACTIVE.delete(taskId);
  } else {
    const orphanPid = await findWorkerPid(taskId, task.workerPid);
    if (orphanPid !== null) await killProcessId(orphanPid);
  }
  await updateMiningTask(taskId, { status: 'canceled', errorMessage: '用户取消任务',
    finishedAt: new Date().toISOString(), workerPid: null });
  return true;
}

export function isMiningWorkerActive(taskId: string): boolean { return ACTIVE.has(taskId); }

export function buildWorkerConfig(base: Record<string, unknown>, values: {
  snapshotRoot: string; outputRoot: string; totalGenerations: number;
}): Record<string, unknown> {
  const data: Record<string, unknown> = {
    ...asRecord(base.data), source: 'snapshot', snapshot_root: values.snapshotRoot,
  };
  delete data.password;
  return {
    ...base,
    data,
    // Web worker 每代只写几十 KB 的检查点；逐代保存可避免超时/取消后
    // 丢失最多 checkpoint_freq-1 代（全市场单代通常需要数分钟）。
    evolution: { ...asRecord(base.evolution), generations: values.totalGenerations, checkpoint_freq: 1 },
    primitives: {
      ...asRecord(base.primitives),
      terminals: restrictList(asRecord(base.primitives).terminals, AST_TERMINALS),
      functions: restrictList(asRecord(base.primitives).functions, AST_FUNCTIONS),
    },
    report: { ...asRecord(base.report), out_dir: values.outputRoot },
    persistence: { ...asRecord(base.persistence), enabled: false },
  };
}

async function importWorkerCandidates(taskId: string, outputRoot: string): Promise<number> {
  const rows = JSON.parse(await readFile(join(outputRoot, 'candidates.json'), 'utf8')) as Array<Record<string, unknown>>;
  const lineage = JSON.parse(await readFile(join(outputRoot, 'run_manifest.json'), 'utf8')) as Record<string, unknown>;
  let imported = 0;
  for (const row of rows) {
    if (row.ast_compatible !== true || typeof row.ast_json !== 'string') continue;
    const expression = JSON.parse(row.ast_json) as AstFactorExpression;
    await createFactorCandidate({
      taskId, name: `自动候选 ${imported + 1}`, formula: String(row.formula ?? row.prefix ?? ''),
      expression, direction: inferDirection(row) as FactorDirection,
      validationMetrics: row, sourceLineage: lineage,
    });
    imported += 1;
  }
  return imported;
}

function inferDirection(row: Record<string, unknown>): FactorDirection {
  return Number(row.test_rankic ?? 0) < 0 ? 'lower-is-better' : 'higher-is-better';
}

async function terminateWorker(taskId: string, reason: string) {
  const active = ACTIVE.get(taskId);
  if (!active) return;
  active.canceled = true;
  await killProcessTree(active.child);
  ACTIVE.delete(taskId);
  await finishFailed(taskId, reason);
}

async function finishFailed(taskId: string, message: string) {
  await updateMiningTask(taskId, { status: 'failed', errorMessage: message.slice(0, 1000),
    finishedAt: new Date().toISOString(), workerPid: null });
}

async function killProcessTree(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (!child.pid) return;
  await killProcessId(child.pid, child);
}

async function killProcessId(pid: number, fallbackChild?: ChildProcessWithoutNullStreams): Promise<void> {
  if (process.platform === 'win32') {
    await new Promise<void>((resolvePromise) => {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
      killer.once('close', () => resolvePromise());
      killer.once('error', () => { fallbackChild?.kill('SIGKILL'); resolvePromise(); });
    });
  } else {
    try { process.kill(pid, 'SIGTERM'); } catch { fallbackChild?.kill('SIGTERM'); }
  }
}

export function isWorkerCommandForTask(command: string, taskId: string): boolean {
  return command.includes(taskId) && /worker_entry\.py/i.test(command);
}

async function findWorkerPid(taskId: string, storedPid: number | null): Promise<number | null> {
  const output = process.platform === 'win32'
    ? await captureCommand('powershell.exe', ['-NoProfile', '-Command',
      "$id=$env:FACTOR_MINING_TASK_ID; Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like \"*$id*\" -and $_.CommandLine -match 'worker_entry\\.py' } | ForEach-Object { \"$($_.ProcessId)`t$($_.CommandLine)\" }"],
      { FACTOR_MINING_TASK_ID: taskId })
    : await captureCommand('ps', ['-eo', 'pid=,args=']);
  const matches = output.split(/\r?\n/).map((line) => {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    return match ? { pid: Number(match[1]), command: match[2] } : null;
  }).filter((item): item is { pid: number; command: string } => Boolean(item))
    .filter((item) => isWorkerCommandForTask(item.command, taskId));
  if (storedPid && matches.some((item) => item.pid === storedPid)) return storedPid;
  return matches[0]?.pid ?? null;
}

async function captureCommand(command: string, args: string[], extraEnv: Record<string, string> = {}): Promise<string> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { windowsHide: true, env: { ...process.env, ...extraEnv } });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    child.once('close', () => resolvePromise(output));
    child.once('error', () => resolvePromise(''));
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function restrictList(value: unknown, allowed: string[]): string[] {
  if (!Array.isArray(value)) return allowed;
  const requested = new Set(value.map(String));
  const restricted = allowed.filter((item) => requested.has(item));
  return restricted.length ? restricted : allowed;
}
