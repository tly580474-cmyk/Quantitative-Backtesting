import { useCallback, useEffect, useRef, useState } from 'react';
import type { MarketDataset } from '@/models';

interface DatasetLibraryLoadState {
  datasets: MarketDataset[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<MarketDataset[]>;
  retry: () => void;
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : '本地数据集加载失败';
}

/** Loads the local dataset catalog without confusing an in-flight request with an empty catalog. */
export function useDatasetLibraryLoad(
  loadDatasets: () => Promise<MarketDataset[]>,
): DatasetLibraryLoadState {
  const [datasets, setDatasets] = useState<MarketDataset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const datasetsRef = useRef<MarketDataset[]>([]);
  const mountedRef = useRef(false);
  const requestRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestRef.current += 1;
    };
  }, []);

  const refresh = useCallback(async () => {
    const requestId = ++requestRef.current;
    if (mountedRef.current) {
      setLoading(true);
      setError(null);
    }
    try {
      const nextDatasets = await loadDatasets();
      if (!mountedRef.current || requestRef.current !== requestId) return datasetsRef.current;
      datasetsRef.current = nextDatasets;
      setDatasets(nextDatasets);
      return nextDatasets;
    } catch (loadError) {
      if (!mountedRef.current || requestRef.current !== requestId) return datasetsRef.current;
      setError(getErrorMessage(loadError));
      throw loadError;
    } finally {
      if (mountedRef.current && requestRef.current === requestId) setLoading(false);
    }
  }, [loadDatasets]);

  useEffect(() => {
    void refresh().catch(() => undefined);
  }, [refresh]);

  const retry = useCallback(() => {
    void refresh().catch(() => undefined);
  }, [refresh]);

  return { datasets, loading, error, refresh, retry };
}
