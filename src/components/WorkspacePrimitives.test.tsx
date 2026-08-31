import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { financialTone, MetricStrip, PageHeader, WorkbenchEmpty } from './WorkspacePrimitives';

afterEach(cleanup);

describe('workbench visual primitives', () => {
  it('separates signed finance values from risk and task status', () => {
    expect(financialTone(0.12)).toBe('positive');
    expect(financialTone(-0.05)).toBe('negative');
    for (const value of [0, null, undefined, NaN, Infinity]) expect(financialTone(value)).toBe('neutral');
  });

  it('keeps labels and explicit risk notes with each metric', () => {
    render(<MetricStrip items={[
      { label: '收益率', value: '+12.00%', tone: 'positive' },
      { label: '最大回撤', value: '8.00%', tone: 'risk', note: '风险指标' },
    ]} />);
    expect(screen.getByText('+12.00%').closest('.workspace-metric')?.className).toContain('is-positive');
    expect(screen.getByText('8.00%').closest('.workspace-metric')?.className).toContain('is-risk');
    expect(screen.getByText('风险指标')).toBeTruthy();
    expect(screen.getAllByRole('term')).toHaveLength(2);
  });

  it('provides a page identity and an actionable empty state', () => {
    render(<><PageHeader title="研究报告" description="查看研究证据" />
      <WorkbenchEmpty title="尚无报告" description="先打开一个研究任务" action={<button>开始研究</button>} /></>);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('研究报告');
    expect(screen.getByRole('button', { name: '开始研究' })).toBeTruthy();
  });
});
