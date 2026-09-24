import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { DataUpdateProgressPanel } from './App';
import type { DataUpdateProgressItem } from './types';

afterEach(cleanup);

function financialFailure(message: string): DataUpdateProgressItem {
  return {
    key: 'financial_reports', label: '财务报表', status: 'failed', phase: 'failed',
    completed: 0, failed: 0, total: 0, percent: null,
    startedAt: null, updatedAt: null, finishedAt: null, message,
  };
}

describe('financial update progress presentation', () => {
  it('shows a failure once instead of duplicating it in the counters', () => {
    const message = '财务报表采集超过 30 分钟，已终止';
    render(<DataUpdateProgressPanel items={[financialFailure(message)]} />);
    expect(screen.getAllByText(message)).toHaveLength(1);
    expect(screen.getByText('未返回数量统计')).toBeInTheDocument();
  });

  it('keeps a long error inside a closed details element', () => {
    const message = '采集错误的详细说明。'.repeat(40);
    const { container } = render(<DataUpdateProgressPanel items={[financialFailure(message)]} />);
    expect(container.querySelector('details')).not.toHaveAttribute('open');
    expect(container.querySelector('details pre')).toHaveTextContent(message);
    expect(container.querySelector('.data-update-meta')).not.toHaveTextContent(message);
  });

  it('opens the bottom-right detail view and lists recorded failures', () => {
    render(<DataUpdateProgressPanel items={[{
      ...financialFailure('部分失败'), completed: 198, failed: 2, total: 200,
      failureDetailsTotal: 2,
      failureDetails: [
        { period: '2026-06-30', symbol: '600426', stage: '字段缺失', message: '净利润缺失' },
        { period: '2026-03-31', symbol: '600000', stage: '接口请求', message: '连接超时' },
      ],
    }]} />);
    fireEvent.click(screen.getByRole('button', { name: /查看详情/ }));
    expect(screen.getByRole('dialog', { name: '财务报表更新详情' })).toBeInTheDocument();
    expect(screen.getByText('600426')).toBeInTheDocument();
    expect(screen.getByText('净利润缺失')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
