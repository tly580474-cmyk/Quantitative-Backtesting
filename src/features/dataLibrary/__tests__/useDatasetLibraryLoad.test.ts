import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { MarketDataset } from '@/models';
import { useDatasetLibraryLoad } from '../useDatasetLibraryLoad';

const dataset = { id: 'dataset-1', name: '沪深300' } as MarketDataset;

describe('useDatasetLibraryLoad', () => {
  it('does not let a slow earlier request overwrite a fast refresh', async () => {
    let resolveFirst!: (value: MarketDataset[]) => void;
    let resolveSecond!: (value: MarketDataset[]) => void;
    const firstRequest = new Promise<MarketDataset[]>((resolve) => { resolveFirst = resolve; });
    const secondRequest = new Promise<MarketDataset[]>((resolve) => { resolveSecond = resolve; });
    const staleDataset = { id: 'stale', name: '旧目录' } as MarketDataset;
    const loadDatasets = vi.fn<() => Promise<MarketDataset[]>>()
      .mockReturnValueOnce(firstRequest)
      .mockReturnValueOnce(secondRequest);
    const { result } = renderHook(() => useDatasetLibraryLoad(loadDatasets));

    await waitFor(() => expect(loadDatasets).toHaveBeenCalledTimes(1));
    let refreshPromise!: Promise<MarketDataset[]>;
    act(() => {
      refreshPromise = result.current.refresh();
    });
    expect(loadDatasets).toHaveBeenCalledTimes(2);

    await act(async () => {
      resolveSecond([dataset]);
      await refreshPromise;
    });
    expect(result.current.datasets).toEqual([dataset]);

    await act(async () => {
      resolveFirst([staleDataset]);
      await Promise.resolve();
    });
    expect(result.current.datasets).toEqual([dataset]);
  });

  it('shows a load error first, then clears it after a successful retry', async () => {
    const loadDatasets = vi.fn<() => Promise<MarketDataset[]>>()
      .mockRejectedValueOnce(new Error('IndexedDB 暂不可用'))
      .mockResolvedValueOnce([dataset]);
    const { result } = renderHook(() => useDatasetLibraryLoad(loadDatasets));

    await waitFor(() => expect(result.current.error).toBe('IndexedDB 暂不可用'));
    expect(result.current.loading).toBe(false);
    expect(result.current.datasets).toEqual([]);

    act(() => result.current.retry());
    await waitFor(() => expect(result.current.datasets).toEqual([dataset]));
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(loadDatasets).toHaveBeenCalledTimes(2);
  });

  it('only exposes the empty catalog after the first request finishes', async () => {
    const loadDatasets = vi.fn<() => Promise<MarketDataset[]>>().mockResolvedValue([]);
    const { result } = renderHook(() => useDatasetLibraryLoad(loadDatasets));

    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeNull();
    expect(result.current.datasets).toEqual([]);
  });
});
