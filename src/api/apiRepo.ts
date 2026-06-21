import type { IDataRepository } from './repository';
import { apiFetch, ApiError } from './client';
import type { MarketDataset, StoredCandle, Candle, BacktestResult, EquityPoint, StrategyConfig } from '@/models';
import type {
  VisualStrategyDocument,
  StoredVisualStrategy,
  StoredStrategyVersion,
  StoredStrategyDraft,
} from '@/features/visualStrategies/types';

export class ApiRepository implements IDataRepository {
  getSource(): 'api' { return 'api'; }

  async isAvailable(): Promise<boolean> {
    try {
      const res = await apiFetch<{ db: string }>('/api/health');
      return res?.db === 'connected';
    } catch {
      return false;
    }
  }

  // ─── Market Data ────────────────────────────────────────────

  async getDatasets(): Promise<MarketDataset[]> {
    return apiFetch<MarketDataset[]>('/api/datasets');
  }

  async getDataset(id: string): Promise<MarketDataset | undefined> {
    try {
      return await apiFetch<MarketDataset>(`/api/datasets/${id}`);
    } catch (err) {
      if (err instanceof ApiError && err.statusCode === 404) return undefined;
      throw err;
    }
  }

  async saveDataset(dataset: MarketDataset, candles: Candle[]): Promise<void> {
    await apiFetch('/api/datasets', {
      method: 'POST',
      body: JSON.stringify({ dataset, candles }),
    });
  }

  async deleteDataset(id: string): Promise<void> {
    await apiFetch(`/api/datasets/${id}`, { method: 'DELETE' });
  }

  async getCandlesByDataset(datasetId: string): Promise<StoredCandle[]> {
    const result = await apiFetch<{ data: StoredCandle[]; total: number }>(
      `/api/datasets/${datasetId}/candles?offset=0&limit=100000`,
    );
    return result.data;
  }

  async findDuplicateByChecksum(checksum: string): Promise<MarketDataset | undefined> {
    const result = await apiFetch<{ duplicate: boolean; dataset: MarketDataset | null }>(
      '/api/datasets/check-duplicate',
      { method: 'POST', body: JSON.stringify({ checksum }) },
    );
    return result.duplicate ? result.dataset ?? undefined : undefined;
  }

  async datasetExists(id: string): Promise<boolean> {
    const ds = await this.getDataset(id);
    return ds != null;
  }

  // ─── Strategy Configs ───────────────────────────────────────

  async getStrategyConfigs(): Promise<StrategyConfig[]> {
    return apiFetch<StrategyConfig[]>('/api/strategy-configs');
  }

  async saveStrategyConfig(config: StrategyConfig): Promise<void> {
    await apiFetch('/api/strategy-configs', {
      method: 'POST',
      body: JSON.stringify(config),
    });
  }

  async getStrategyConfig(id: string): Promise<StrategyConfig | undefined> {
    try {
      return await apiFetch<StrategyConfig>(`/api/strategy-configs/${id}`);
    } catch (err) {
      if (err instanceof ApiError && err.statusCode === 404) return undefined;
      throw err;
    }
  }

  async deleteStrategyConfig(id: string): Promise<void> {
    await apiFetch(`/api/strategy-configs/${id}`, { method: 'DELETE' });
  }

  // ─── Backtest Results ───────────────────────────────────────

  async getResults(): Promise<BacktestResult[]> {
    return apiFetch<BacktestResult[]>('/api/results');
  }

  async getResult(id: string): Promise<BacktestResult | undefined> {
    try {
      return await apiFetch<BacktestResult>(`/api/results/${id}`);
    } catch (err) {
      if (err instanceof ApiError && err.statusCode === 404) return undefined;
      throw err;
    }
  }

  async saveResult(result: BacktestResult, equityCurve: EquityPoint[]): Promise<void> {
    await apiFetch('/api/results', {
      method: 'POST',
      body: JSON.stringify({ result, equityPoints: equityCurve }),
    });
  }

  async deleteResult(id: string): Promise<void> {
    await apiFetch(`/api/results/${id}`, { method: 'DELETE' });
  }

  async deleteResults(ids: string[]): Promise<void> {
    await apiFetch('/api/results/bulk-delete', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    });
  }

  async getEquityPoints(resultId: string): Promise<EquityPoint[]> {
    const result = await apiFetch<{ data: EquityPoint[]; total: number }>(
      `/api/results/${resultId}/equity-points?offset=0&limit=100000`,
    );
    return result.data;
  }

  // ─── Visual Strategies ──────────────────────────────────────

  async getAllVisualStrategies(): Promise<StoredVisualStrategy[]> {
    return apiFetch<StoredVisualStrategy[]>('/api/visual-strategies');
  }

  async getVisualStrategyById(id: string): Promise<StoredVisualStrategy | undefined> {
    try {
      return await apiFetch<StoredVisualStrategy>(`/api/visual-strategies/${id}`);
    } catch (err) {
      if (err instanceof ApiError && err.statusCode === 404) return undefined;
      throw err;
    }
  }

  async saveVisualStrategy(strategy: StoredVisualStrategy): Promise<void> {
    await apiFetch('/api/visual-strategies', {
      method: 'POST',
      body: JSON.stringify(strategy),
    });
  }

  async deleteVisualStrategy(id: string): Promise<void> {
    await apiFetch(`/api/visual-strategies/${id}`, { method: 'DELETE' });
  }

  async publishVisualStrategy(id: string, document: VisualStrategyDocument): Promise<void> {
    await apiFetch(`/api/visual-strategies/${id}/publish`, {
      method: 'POST',
      body: JSON.stringify({ document }),
    });
  }

  async getVersionsForStrategy(strategyId: string): Promise<StoredStrategyVersion[]> {
    return apiFetch<StoredStrategyVersion[]>(`/api/visual-strategies/${strategyId}/versions`);
  }

  async getStrategyVersion(strategyId: string, version: number): Promise<StoredStrategyVersion | undefined> {
    try {
      return await apiFetch<StoredStrategyVersion>(
        `/api/visual-strategies/${strategyId}/versions/${version}`,
      );
    } catch (err) {
      if (err instanceof ApiError && err.statusCode === 404) return undefined;
      throw err;
    }
  }

  async saveDraft(draft: StoredStrategyDraft): Promise<void> {
    await apiFetch(`/api/visual-strategies/${draft.strategyId}/draft`, {
      method: 'PUT',
      body: JSON.stringify(draft),
    });
  }

  async getDraftForStrategy(strategyId: string): Promise<StoredStrategyDraft | undefined> {
    try {
      return await apiFetch<StoredStrategyDraft>(
        `/api/visual-strategies/${strategyId}/draft`,
      );
    } catch {
      return undefined;
    }
  }

  async deleteDraft(strategyId: string): Promise<void> {
    await apiFetch(`/api/visual-strategies/${strategyId}/draft`, { method: 'DELETE' });
  }
}
