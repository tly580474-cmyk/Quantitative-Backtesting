import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
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
});
