// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({ script: '', timeout: 5000, finish: vi.fn(), progress: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  const execFile = vi.fn();
  Object.defineProperty(execFile, promisify.custom, {
    value: (_file: string, _args: string[], options: Record<string, unknown>) =>
      promisify(actual.execFile)(process.execPath, ['-e', harness.script], { ...options, timeout: harness.timeout }),
  });
  return { ...actual, execFile };
});
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs/promises')>(),
  mkdir: vi.fn().mockResolvedValue(undefined), writeFile: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./marketSession.js', () => ({ getChinaMarketSession: () => ({ minuteOfDay: 1200, tradeDate: '2026-08-31' }) }));
vi.mock('../repositories/collectorRunRepository.js', () => ({
  tryStartCollectorRun: vi.fn().mockResolvedValue(true),
  finishCollectorRun: harness.finish,
  updateCollectorRunDetails: harness.progress,
}));

import { startFinancialDataScheduler, stopFinancialDataScheduler } from './financialDataScheduler.js';

beforeEach(() => {
  harness.timeout = 5000;
  harness.finish.mockReset().mockResolvedValue(undefined);
  harness.progress.mockReset().mockResolvedValue(undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  stopFinancialDataScheduler();
  vi.restoreAllMocks();
});

function emit(status: string, failedSymbols = 0): string {
  return `console.log(${JSON.stringify(JSON.stringify({
    status, source: 'sina', apiRows: { symbols: 3, failedSymbols }, totalSymbols: 200, writtenReports: 357,
  }))});`;
}

async function run(): Promise<void> {
  startFinancialDataScheduler({ updateTime: '19:00', lookbackDays: 21 });
  await vi.waitFor(() => expect(harness.finish).toHaveBeenCalledTimes(1), { timeout: 6000 });
}

describe('financial scheduler process boundary', () => {
  it('streams progress and persists a valid successful result', async () => {
    harness.script = emit('running') + emit('completed');
    await run();
    expect(harness.progress).toHaveBeenCalled();
    expect(harness.finish).toHaveBeenCalledWith(expect.any(String), 'succeeded', {
      details: expect.objectContaining({ writtenReports: 357, logPath: expect.stringContaining('financial-data') }),
    });
  });

  it('retains committed counts on a nonzero partial exit', async () => {
    harness.script = emit('partial', 197) + 'process.exitCode = 1;';
    await run();
    expect(harness.finish).toHaveBeenCalledWith(expect.any(String), 'failed', {
      errorMessage: expect.stringContaining('部分失败'),
      details: expect.objectContaining({ writtenReports: 357, process: expect.objectContaining({ code: 1 }) }),
    });
  });

  it('recovers a checkpoint and records the timeout signal', async () => {
    harness.timeout = 500;
    harness.script = emit('running') + 'setInterval(() => {}, 1000);';
    await run();
    expect(harness.finish).toHaveBeenCalledWith(expect.any(String), 'failed', {
      errorMessage: expect.stringContaining('超过 30 分钟'),
      details: expect.objectContaining({ writtenReports: 357, process: expect.objectContaining({ killed: true }) }),
    });
  });

  it('rejects an empty zero-exit response rather than claiming success', async () => {
    harness.script = 'console.log("unstructured output");';
    await run();
    expect(harness.finish.mock.calls[0][1]).toBe('failed');
  });
});
