import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../features/marketData/MarketDataPage', () => ({
  default: ({
    instrumentCode,
    onOpenDetail,
  }: {
    instrumentCode?: string;
    onOpenDetail?: (stock: {
      code: string;
      name: string;
      market: string;
      type: string;
    }) => void;
  }) => <div>
    <span data-testid="instrument-code">{instrumentCode}</span>
    <button
      type="button"
      onClick={() => onOpenDetail?.({
        code: '000048',
        name: '京基智农',
        market: 'SZ',
        type: 'stock',
      })}
    >
      打开京基智农
    </button>
  </div>,
}));

import { MarketDetailRoute } from '../App';

describe('MarketDetailRoute', () => {
  it('updates the route when an index constituent opens in stock detail', async () => {
    render(
      <MemoryRouter initialEntries={['/market-detail/sh000852']}>
        <Routes>
          <Route path="/market-detail/:code" element={<MarketDetailRoute />} />
        </Routes>
      </MemoryRouter>,
    );

    expect((await screen.findByTestId('instrument-code')).textContent).toBe('sh000852');
    fireEvent.click(screen.getByRole('button', { name: '打开京基智农' }));
    await waitFor(() => {
      expect(screen.getByTestId('instrument-code').textContent).toBe('000048');
    });
  });
});
