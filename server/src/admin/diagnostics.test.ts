import { describe, expect, it } from 'vitest';
import {
  buildCoverageDiagnosticDetails,
  ensureDiagnosticDetails,
} from './diagnostics.js';

describe('admin diagnostic details', () => {
  it('adds actionable fallback details to every warning or critical check', () => {
    const [warning, critical, healthy] = ensureDiagnosticDetails([
      {
        id: 'warning-check',
        title: '警告检查',
        level: 'warning',
        summary: '检测到警告。',
      },
      {
        id: 'critical-check',
        title: '严重检查',
        level: 'critical',
        summary: '检测到错误。',
      },
      {
        id: 'healthy-check',
        title: '正常检查',
        level: 'healthy',
        summary: '检查通过。',
      },
    ]);
    expect(warning.details).toEqual([
      { label: '检查标识', value: 'warning-check' },
      { label: '检测结果', value: '检测到警告。', level: 'warning' },
    ]);
    expect(critical.details?.length).toBeGreaterThan(0);
    expect(healthy.details).toBeUndefined();
  });

  it('lists each failing coverage domain with range, threshold, and current value', () => {
    const details = buildCoverageDiagnosticDetails([
      {
        key: 'valuations',
        label: '日线估值与市值',
        status: 'fail',
        rows: 100,
        covered: 80,
        total: 100,
        coverage: 0.8,
        minDate: '2025-01-01',
        maxDate: '2026-07-27',
        message: '80/100，覆盖率 80.00%',
        details: { passThreshold: 0.95 },
      },
      {
        key: 'daily_prices',
        label: '股票日线行情',
        status: 'pass',
        rows: 100,
        covered: 100,
        total: 100,
        coverage: 1,
        minDate: '2025-01-01',
        maxDate: '2026-07-27',
        message: '100/100，覆盖率 100.00%',
      },
    ]);
    expect(details).toHaveLength(1);
    expect(details[0]).toMatchObject({
      label: '日线估值与市值',
      value: '80/100，覆盖率 80.00%',
      level: 'critical',
    });
    expect(details[0].hint).toContain('passThreshold=95.00%');
  });

  it('shows the rule threshold for legacy cached coverage rows without details', () => {
    const [detail] = buildCoverageDiagnosticDetails([{
      key: 'dividends',
      label: '分红历史状态',
      status: 'warn',
      rows: 10,
      covered: 99,
      total: 100,
      coverage: 0.99,
      minDate: '2020-01-01',
      maxDate: '2026-07-28',
      message: '99/100，覆盖率 99.00%',
    }]);
    expect(detail.hint).toContain('通过条件：覆盖率 = 100%');
  });
});
