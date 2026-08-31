import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import HistoryCards from './HistoryCards';

afterEach(cleanup);

it('keeps loading distinct from an empty history', () => {
  const { rerender, container } = render(<HistoryCards items={[]} loading empty={<p>暂无报告</p>}
    itemKey={(item: string) => item} renderItem={(item) => item} />);
  expect(screen.queryByText('暂无报告')).toBeNull();
  expect(container.querySelector('.ant-skeleton')).toBeTruthy();
  rerender(<HistoryCards items={[]} loading={false} empty={<p>暂无报告</p>}
    itemKey={(item: string) => item} renderItem={(item) => item} />);
  expect(screen.getByText('暂无报告')).toBeTruthy();
});

it('keeps mobile histories paginated and preserves record actions', () => {
  render(<HistoryCards items={Array.from({ length: 25 }, (_, index) => `任务${index}`)} loading={false}
    empty="暂无记录" itemKey={(item) => item} renderItem={(item) => <button>查看{item}</button>} />);
  expect(screen.getAllByRole('button', { name: /查看任务/ })).toHaveLength(20);
  expect(screen.queryByRole('button', { name: '查看任务24' })).toBeNull();
});
