import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { getChinaMarketSession } from './marketSession.js';
import { finishCollectorRun, tryStartCollectorRun } from '../repositories/collectorRunRepository.js';

const execFileAsync = promisify(execFile);

export interface FinancialDataSchedulerConfig {
  updateTime: string;
  lookbackDays: number;
  pythonExecutable?: string;
}

let intervalId: ReturnType<typeof setInterval> | null = null;
let running = false;
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
  config = null;
}

export function isFinancialUpdateDue(minuteOfDay: number, target: string): boolean {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(target);
  return Boolean(match && minuteOfDay >= Number(match![1]) * 60 + Number(match![2]));
}

async function tick(): Promise<void> {
  if (running || !config) return;
  const session = getChinaMarketSession();
  if (!isFinancialUpdateDue(session.minuteOfDay, config.updateTime)) return;
  const runKey = `financial_reports:${session.tradeDate}:${config.updateTime}`;
  if (!await tryStartCollectorRun(runKey, 'financial_reports')) return;
  running = true;
  try {
    const script = fileURLToPath(new URL('../../referenceData/financial_update.py', import.meta.url));
    const { stdout, stderr } = await execFileAsync(config.pythonExecutable || 'python', [
      script,
      '--lookback-days', String(Math.max(7, config.lookbackDays)),
      '--batch-size', '200',
      '--workers', '4',
    ], {
      cwd: fileURLToPath(new URL('../../../', import.meta.url)),
      timeout: 30 * 60_000,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    const output = stdout.trim().split(/\r?\n/).at(-1);
    let details: Record<string, unknown> = { source: 'tushare' };
    if (output) {
      try {
        details = { ...details, ...JSON.parse(output) as Record<string, unknown> };
      } catch {
        details.output = output.slice(0, 2000);
      }
    }
    if (stderr.trim()) details.warning = stderr.trim().slice(0, 2000);
    await finishCollectorRun(runKey, 'succeeded', { details });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finishCollectorRun(runKey, 'failed', { errorMessage: message });
    console.error(`[financialDataScheduler] ${runKey} failed: ${message}`);
  } finally {
    running = false;
  }
}
