import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMobileLayout } from '@/components/mobile/useMobileLayout';
import MarketFactorList from './MarketFactorList';

vi.mock('@/components/mobile/useMobileLayout', () => ({ useMobileLayout: vi.fn() }));
const items = [
  { key: 'A', label: '市场广度', description: '广度计算公式', content: <span>市场广度 35%</span> },
  { key: 'B', label: '涨幅动能', description: '动能计算公式', content: <span>涨幅动能 25%</span> },
];

beforeEach(() => vi.mocked(useMobileLayout).mockReturnValue(true));
afterEach(cleanup);

describe('MarketFactorList touch explanations', () => {
  it('opens only one inline explanation and toggles it closed', () => {
    render(<MarketFactorList items={items} />);
    const first = screen.getByRole('button', { name: '市场广度说明' });
    const second = screen.getByRole('button', { name: '涨幅动能说明' });
    expect(screen.queryAllByRole('region')).toHaveLength(0);
    fireEvent.click(first);
    expect(first.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('region', { name: '市场广度计算说明' }).id).toBe(first.getAttribute('aria-controls'));
    fireEvent.click(second);
    expect(first.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryAllByRole('region')).toHaveLength(1);
    expect(screen.getByRole('region').textContent).toBe('动能计算公式');
    fireEvent.click(second);
    expect(screen.queryAllByRole('region')).toHaveLength(0);
  });

  it('does not create hover tooltips on touch rows', () => {
    render(<MarketFactorList items={items} />);
    for (const row of screen.getAllByRole('button')) fireEvent.mouseEnter(row);
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(screen.queryAllByRole('region')).toHaveLength(0);
  });

  it('keeps desktop descriptions keyboard-focusable without mobile disclosures', () => {
    vi.mocked(useMobileLayout).mockReturnValue(false);
    render(<MarketFactorList items={items} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByLabelText('市场广度说明').getAttribute('tabindex')).toBe('0');
  });
});
