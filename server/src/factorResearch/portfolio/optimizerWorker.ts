import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

export interface PortfolioOptimizerResult {
  status: 'solved' | 'failed';
  message: string;
  weights: Array<{ instrumentKey: number; weight: number }>;
  constraintMargins: Record<string, number>;
  risk: Record<string, number>;
  solver?: { name: string; iterations: number };
}

export async function runPortfolioOptimizer(options: {
  payload: Record<string, unknown>;
  pythonExecutable: string;
  workerPath: string;
  timeoutMs?: number;
}): Promise<PortfolioOptimizerResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(options.pythonExecutable, [resolve(options.workerPath)], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1', OMP_NUM_THREADS: '1' },
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result: PortfolioOptimizerResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(failed('optimizer worker timed out; existing positions must be retained'));
    }, options.timeoutMs ?? 60_000);
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', (error) => finish(failed(`optimizer worker failed to start: ${error.message}`)));
    child.on('close', (code) => {
      if (code !== 0) return finish(failed(`optimizer worker exited ${code}: ${stderr.slice(-500)}`));
      try {
        const parsed = JSON.parse(stdout) as PortfolioOptimizerResult;
        if (parsed.status !== 'solved') {
          return finish({ ...failed(parsed.message || 'optimizer failed'), ...parsed, weights: [] });
        }
        finish(parsed);
      } catch {
        finish(failed('optimizer returned invalid JSON; existing positions must be retained'));
      }
    });
    child.stdin.end(JSON.stringify(options.payload));
  });
}

function failed(message: string): PortfolioOptimizerResult {
  return { status: 'failed', message, weights: [], constraintMargins: {}, risk: {} };
}
