import { App as AntdApp, ConfigProvider } from 'antd';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getRepository } from '@/api/useRepository';
import { useCandleStore } from '@/stores/useCandleStore';
import { useBacktest } from './useBacktest';
import BacktestRunner from './BacktestRunner';

vi.mock('@/api/useRepository', () => ({ getRepository: vi.fn() }));
vi.mock('./useBacktest', () => ({ useBacktest: vi.fn() }));
vi.mock('@/features/chart/ChartContainer', () => ({ default: () => <div data-testid="chart-placeholder" /> }));

const mockedGetRepository = vi.mocked(getRepository);
const mockedUseBacktest = vi.mocked(useBacktest);
const repository = {
  getDatasets: vi.fn(),
  getCandlesByDataset: vi.fn(),
  getAllVisualStrategies: vi.fn(),
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const datasetA = {
  id: 'dataset-a',
  name: '数据集 A',
  symbol: 'AAA',
  timeframe: '1d' as const,
  startTime: '2024-01-01',
  endTime: '2024-01-03',
  count: 3,
  checksum: 'a',
  createdAt: '2024-01-01',
  updatedAt: '2024-01-03',
};

const datasetB = { ...datasetA, id: 'dataset-b', name: '数据集 B', symbol: 'BBB', checksum: 'b' };

const barsA = [{ time: '2024-01-01', symbol: 'AAA', open: 1, high: 2, low: 1, close: 2 }];
const barsB = [{ time: '2024-01-01', symbol: 'BBB', open: 3, high: 4, low: 3, close: 4 }];

function setMatchMedia() {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn((media: string) => ({
      matches: false,
      media,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

function renderPage() {
  return render(
    <ConfigProvider>
      <AntdApp>
        <BacktestRunner />
      </AntdApp>
    </ConfigProvider>,
  );
}

beforeEach(() => {
  setMatchMedia();
  useCandleStore.setState({ candles: [], importResult: null, loading: false });
  mockedUseBacktest.mockReturnValue({
    run: vi.fn(),
    cancel: vi.fn(),
    status: 'idle',
    progress: null,
    result: null,
    error: null,
  });
  repository.getDatasets.mockReset();
  repository.getCandlesByDataset.mockReset();
  repository.getAllVisualStrategies.mockReset().mockResolvedValue([]);
  mockedGetRepository.mockReturnValue(repository as never);
});

describe('BacktestRunner dataset states', () => {
  it('shows a retryable load error instead of a permanent loading/empty state', async () => {
    repository.getDatasets.mockRejectedValueOnce(new Error('本地数据库不可用'));
    renderPage();

    await waitFor(() => expect(screen.getByText('数据集加载失败')).toBeTruthy());
    expect(screen.getByText('本地数据库不可用')).toBeTruthy();
    expect(screen.queryByText('暂无可用数据集，请先在数据管理中导入行情数据')).toBeNull();

    repository.getDatasets.mockResolvedValueOnce([]);
    fireEvent.click(screen.getByRole('button', { name: /重\s*试/ }));
    await waitFor(() => expect(screen.getByText('暂无可用数据集，请先在数据管理中导入行情数据')).toBeTruthy());
    expect(screen.queryByText('数据集加载失败')).toBeNull();
  });

  it('keeps the first-run action pending until the dataset list is ready', async () => {
    const datasetsPending = deferred<typeof datasetA[]>();
    repository.getDatasets.mockReturnValueOnce(datasetsPending.promise);
    renderPage();

    expect(screen.getByText('正在读取数据集…')).toBeTruthy();
    expect((screen.getByRole('button', { name: /运行回测/ }) as HTMLButtonElement).disabled).toBe(true);
    datasetsPending.resolve([]);
    await waitFor(() => expect(screen.getByText('暂无可用数据集，请先在数据管理中导入行情数据')).toBeTruthy());
  });

  it('clears old candles and blocks run while switching to a pending dataset', async () => {
    const candlesPending = deferred<typeof barsB>();
    repository.getDatasets.mockResolvedValueOnce([datasetA, datasetB]);
    repository.getCandlesByDataset.mockImplementation((id: string) => (
      id === datasetA.id ? Promise.resolve(barsA) : candlesPending.promise
    ));
    renderPage();
    await waitFor(() => expect(screen.getByTestId('chart-placeholder')).toBeTruthy());

    const datasetSelect = screen.getByRole('combobox', { name: '回测数据集' });
    fireEvent.mouseDown(datasetSelect);
    await waitFor(() => expect(screen.getByText('数据集 B (BBB)')).toBeTruthy());
    fireEvent.click(screen.getByText('数据集 B (BBB)'));

    await waitFor(() => expect(screen.queryByTestId('chart-placeholder')).toBeNull());
    expect((screen.getByRole('button', { name: /运行回测/ }) as HTMLButtonElement).disabled).toBe(true);
    candlesPending.resolve(barsB);
    await waitFor(() => expect(screen.getByTestId('chart-placeholder')).toBeTruthy());
  });

  it('ignores a late candle response after the page is unmounted', async () => {
    const candlesPending = deferred<typeof barsA>();
    repository.getDatasets.mockResolvedValueOnce([datasetA]);
    repository.getCandlesByDataset.mockReturnValueOnce(candlesPending.promise);
    const view = renderPage();
    await waitFor(() => expect(repository.getCandlesByDataset).toHaveBeenCalledWith(datasetA.id));
    view.unmount();
    candlesPending.resolve(barsA);
    await candlesPending.promise;
    expect(useCandleStore.getState().candles).toEqual([]);
  });
});
