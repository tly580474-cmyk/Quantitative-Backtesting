import { describe, expect, it } from 'vitest';
import { cleanFinancialStderr, isFinancialUpdateDue, parseFinancialOutput, summarizeFinancialFailure } from './financialDataScheduler.js';

describe('financialDataScheduler', () => {
  it('becomes due at and after the configured Shanghai minute without a trading-calendar gate', () => {
    expect(isFinancialUpdateDue(18 * 60 + 59, '19:00')).toBe(false);
    expect(isFinancialUpdateDue(19 * 60, '19:00')).toBe(true);
    expect(isFinancialUpdateDue(20 * 60, '19:00')).toBe(true);
  });

  it('rejects malformed schedule values', () => {
    expect(isFinancialUpdateDue(0, '25:00')).toBe(false);
    expect(isFinancialUpdateDue(0, 'noon')).toBe(false);
  });

  it('recovers the last checkpoint when a process times out mid-output', () => {
    const checkpoint = { status: 'running', apiRows: { symbols: 12, failedSymbols: 2 }, writtenReports: 1300 };
    expect(parseFinancialOutput(`library log\n${JSON.stringify(checkpoint)}\n{"status":`)).toEqual(checkpoint);
    expect(parseFinancialOutput('null\n[]\n{}')).toBeNull();
  });

  it('reports the timeout instead of the dependency warning at the beginning of stderr', () => {
    const result = summarizeFinancialFailure({ killed: true, signal: 'SIGTERM', stderr: 'pkg_resources is deprecated' }, {
      apiRows: { symbols: 12, failedSymbols: 2 },
    });
    expect(result).toContain('超过 30 分钟');
    expect(result).toContain('成功 12 只');
    expect(result).not.toContain('pkg_resources');
    expect(summarizeFinancialFailure({ killed: true, code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' })).toContain('缓冲区');
  });

  it('preserves the actual exception at the tail and discards terminal progress controls', () => {
    const stderr = 'UserWarning: old dependency\r\n\x1b[A 6%|██ | 1/17 [00:01<00:19]\r\nTimeoutError: Sina unavailable';
    expect(cleanFinancialStderr(stderr)).not.toContain('1/17');
    expect(summarizeFinancialFailure({ code: 1, stderr })).toContain('TimeoutError: Sina unavailable');
  });

  it('does not describe partial data as a successful run', () => {
    expect(summarizeFinancialFailure({ code: 1 }, {
      status: 'partial', apiRows: { symbols: 3, failedSymbols: 197 },
    })).toContain('部分失败：成功 3 只、失败 197 只');
  });
});
