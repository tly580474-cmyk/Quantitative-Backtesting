import { execFile } from 'node:child_process';
import { promisify, stripVTControlCharacters } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { getChinaMarketSession } from './marketSession.js';
import { finishCollectorRun, tryStartCollectorRun, updateCollectorRunDetails } from '../repositories/collectorRunRepository.js';

const execFileAsync = promisify(execFile);
const UPDATE_TIMEOUT_MS = 30 * 60_000;

export function parseFinancialOutput(stdout: string): Record<string, unknown> | null {
  for (const line of stdout.trim().split(/\r?\n/).reverse()) {
    try {
      const value: unknown = JSON.parse(line);
      if (value && typeof value === 'object' && !Array.isArray(value)
        && 'status' in value && 'apiRows' in value) return value as Record<string, unknown>;
    } catch { /* Ignore non-protocol library output. */ }
  }
  return null;
}

export function cleanFinancialStderr(stderr: string): string {
  return stripVTControlCharacters(stderr).split(/[\r\n]+/)
    .filter((line) => line.trim() && !/\d+%\|.*\d+\/\d+/.test(line)).join('\n');
}

export function summarizeFinancialFailure(error: unknown, details: Record<string, unknown> = {}): string {
  const failure = error as { code?: string | number; killed?: boolean; signal?: string; stderr?: string } | null;
  const rows = details.apiRows as { symbols?: number; failedSymbols?: number } | undefined;
  const counts = `成功 ${rows?.symbols ?? 0} 只、失败 ${rows?.failedSymbols ?? 0} 只`;
  if (failure?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    return `财务报表日志超过缓冲区上限，任务已终止；${counts}。请检查详细日志。`;
  }
  if (failure?.killed) {
    return `财务报表采集超过 30 分钟，已终止；${counts}，已提交的数据保留。请检查数据源连接和详细日志。`;
  }
  if (failure?.code === 'ENOENT') return '无法启动财务采集：未找到 Python 解释器，请检查配置。';
  if (details.status === 'partial') {
    return `财务报表部分失败：${counts}；已提交的数据保留，失败项将在后续轮次重试。`;
  }
  const tail = cleanFinancialStderr(failure?.stderr ?? '').split('\n').at(-1);
  return `财务报表采集失败：${tail || (error instanceof Error ? error.message.split('\n')[0] : String(error))}`.slice(0, 900);
}

export interface FinancialDataSchedulerConfig {
  updateTime: string;
  lookbackDays: number;
  pythonExecutable?: string;
}

let intervalId: ReturnType<typeof setInterval> | null = null;
let running = false;
let retryAfter = 0;
let config: FinancialDataSchedulerConfig | null = null;

export function startFinancialDataScheduler(input: FinancialDataSchedulerConfig): void {
  if (intervalId) return;
  config = input;
  void tick();
  intervalId = setInterval(() => void tick(), 60_000);
}

export function stopFinancialDataScheduler(): void {
  if (intervalId) clearInterval(intervalId);
  intervalId = null;
  running = false;
  retryAfter = 0;
  config = null;
}

export function isFinancialUpdateDue(minuteOfDay: number, target: string): boolean {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(target);
  return Boolean(match && minuteOfDay >= Number(match![1]) * 60 + Number(match![2]));
}

async function tick(): Promise<void> {
  if (running || !config || Date.now() < retryAfter) return;
  const runConfig = config;
  const session = getChinaMarketSession();
  if (!isFinancialUpdateDue(session.minuteOfDay, config.updateTime)) return;
  const runKey = `financial_reports:${session.tradeDate}:${config.updateTime}`;
  running = true;
  try {
    if (!await tryStartCollectorRun(runKey, 'financial_reports', { retryDelayMinutes: 10 })) return;
    const script = fileURLToPath(new URL('../../referenceData/financial_update.py', import.meta.url));
    const execution = execFileAsync(runConfig.pythonExecutable || 'python', [
      script,
      '--provider', 'sina',
      '--lookback-days', String(Math.max(7, runConfig.lookbackDays)),
      '--batch-size', '200',
      '--workers', '4',
    ], {
      cwd: fileURLToPath(new URL('../../../', import.meta.url)),
      timeout: UPDATE_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1', TQDM_DISABLE: '1' },
    });
    let details: Record<string, unknown> = { source: 'sina' };
    let progressWrites = Promise.resolve();
    const reader = execution.child.stdout ? createInterface({ input: execution.child.stdout }) : null;
    reader?.on('line', (line) => {
      const progress = parseFinancialOutput(line);
      if (!progress) return;
      details = { ...details, ...progress };
      const snapshot = { ...details };
      progressWrites = progressWrites.then(() => updateCollectorRunDetails(runKey, snapshot))
        .catch((error: unknown) => console.error('[financialDataScheduler] progress write failed', error));
    });
    let stdout = '';
    let stderr = '';
    let failure: unknown;
    try {
      ({ stdout, stderr } = await execution);
    } catch (error) {
      failure = error;
      const output = error as { stdout?: string; stderr?: string };
      stdout = output.stdout ?? '';
      stderr = output.stderr ?? '';
    } finally {
      reader?.close();
      await progressWrites;
    }
    details = { ...details, ...parseFinancialOutput(stdout) };
    if (stderr.trim()) details.warning = cleanFinancialStderr(stderr).slice(-4000);
    const logDirectory = fileURLToPath(new URL('../../../.logs/financial-data/', import.meta.url));
    try {
      await mkdir(logDirectory, { recursive: true });
      const logPath = join(logDirectory, `${runKey.replace(/[^a-zA-Z0-9_-]/g, '-')}-${Date.now()}.log`);
      await writeFile(logPath, `STDOUT\n${stdout}\nSTDERR\n${stderr}`, 'utf8');
      details.logPath = logPath;
    } catch (error) {
      console.error('[financialDataScheduler] log write failed', error);
    }
    if (failure || details.status !== 'completed') {
      retryAfter = Date.now() + 10 * 60_000;
      const message = summarizeFinancialFailure(failure ?? new Error('采集脚本未返回完成结果'), details);
      const processFailure = failure as { code?: string | number; signal?: string; killed?: boolean } | undefined;
      details.process = { code: processFailure?.code ?? null, signal: processFailure?.signal ?? null, killed: processFailure?.killed ?? false };
      await finishCollectorRun(runKey, 'failed', { errorMessage: message, details });
      console.error(`[financialDataScheduler] ${runKey} failed: ${message}`);
    } else {
      await finishCollectorRun(runKey, 'succeeded', { details });
    }
  } catch (error) {
    retryAfter = Date.now() + 10 * 60_000;
    const message = error instanceof Error ? error.message : String(error);
    await finishCollectorRun(runKey, 'failed', { errorMessage: message });
    console.error(`[financialDataScheduler] ${runKey} failed: ${message}`);
  } finally {
    running = false;
  }
}
