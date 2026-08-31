import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { BacktestMetrics } from '@/models';
import ResultsOverview from './ResultsOverview';

afterEach(cleanup);

const metrics: BacktestMetrics = {
  initialCapital: 100000, netContributions: 120000, finalEquity: 150000,
  totalReturn: 0.25, annualizedReturn: 0.12, annualizedVolatility: 0.2,
  riskReturnRatio: 0.6, returnMddRatio: 1.5, sharpeRatio: 1.2,
  maxDrawdown: 0.08, maxDrawdownStart: '2025-01-01', maxDrawdownEnd: '2025-02-01',
  tradeCount: 20, winRate: 0.6, profitFactor: Infinity, avgHoldingDays: 8.2,
  totalCommission: 123.45, totalTax: 67.89, totalSlippage: 10,
  benchmarkReturn: 0.3, excessReturn: -0.05, metricsNote: '按单位净值计算',
};

describe('ResultsOverview', () => {
  it('promotes six metrics while preserving all supporting values', () => {
    const { container } = render(<ResultsOverview metrics={metrics} name="策略 A" />);
    expect(container.querySelectorAll('.workspace-metric')).toHaveLength(6);
    expect(screen.getByText('+25.00%').closest('.workspace-metric')?.className).toContain('is-positive');
    expect(screen.getByText('-5.00%').closest('.workspace-metric')?.className).toContain('is-negative');
    expect(screen.getByText('8.00%').closest('.workspace-metric')?.className).toContain('is-risk');
    expect(container.querySelector('details')?.open).toBe(false);
    expect(screen.getByText('¥120,000.00')).toBeTruthy();
    expect(screen.getByText('∞')).toBeTruthy();
    expect(screen.getByText('按单位净值计算')).toBeTruthy();
  });

  it('does not invent zero for a missing legacy metric', () => {
    render(<ResultsOverview metrics={{ ...metrics, sharpeRatio: undefined } as unknown as BacktestMetrics} name="" />);
    expect(screen.getByText('夏普比率').nextElementSibling?.textContent).toBe('—');
  });
});
