import { StrictMode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '../../api/client';
import StockSelectionPage from './StockSelectionPage';

vi.mock('../../api/client', () => ({ apiFetch: vi.fn() }));
vi.mock('../marketData/StockSelectionWorkspace', () => ({ default: () => <div>技术选股面板</div> }));
vi.mock('./FactorSelectionPanel', () => ({ default: () => <div>因子选股面板</div> }));
vi.mock('./SelectionExportButton', () => ({ default: () => <button type="button">导出</button> }));
vi.mock('./Csi1000LowPbPanel', () => ({
  default: ({ error, onRefresh }: { error: string | null; onRefresh: () => void }) => <div>
    {error && <span>{error}</span>}
    <button type="button" onClick={onRefresh}>重新计算</button>
  </div>,
}));

const fetchMock = vi.mocked(apiFetch);

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('quant-stock-selection-active-strategy-v1', 'csi1000-low-pb');
  fetchMock.mockReset();
  fetchMock.mockImplementation((path) => {
    if (path.includes('csi1000-low-pb-selection')) {
      return Promise.reject(new Error('Route not found'));
    }
    return Promise.resolve({ dataAsOf: '2026-09-04', batches: [] });
  });
});

afterEach(cleanup);

describe('StockSelectionPage low-PB loading', () => {
  it('does not retry a failed initial request until the user asks to retry', async () => {
    render(<StrictMode><MemoryRouter><AntApp><StockSelectionPage /></AntApp></MemoryRouter></StrictMode>);

    expect(await screen.findByText('Route not found')).toBeTruthy();
    const lowPbCalls = () => fetchMock.mock.calls.filter(([path]) => (
      String(path).includes('csi1000-low-pb-selection')
    ));
    await waitFor(() => expect(lowPbCalls()).toHaveLength(1));

    fireEvent.click(screen.getByRole('button', { name: '重新计算' }));
    await waitFor(() => expect(lowPbCalls()).toHaveLength(2));
  });
});
