import { describe, expect, it } from 'vitest';
import type { MarketDataset } from '@/models';
import { getDatasetAssetType } from '../datasetAssetType';

function dataset(overrides: Partial<MarketDataset> = {}): MarketDataset {
  return {
    id: 'dataset-1',
    name: '000001',
    symbol: '000001',
    timeframe: '1d',
    startTime: '2024-01-01',
    endTime: '2024-12-31',
    count: 240,
    checksum: 'checksum',
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('getDatasetAssetType', () => {
  it('uses the explicit asset type when present', () => {
    expect(getDatasetAssetType(dataset({
      assetType: 'stock',
      sourceFileName: '000001_上证指数.xlsx',
    }))).toBe('stock');
  });

  it('recognizes legacy index datasets from their source metadata', () => {
    expect(getDatasetAssetType(dataset({
      symbol: '000852',
      sourceFileName: '000852_中证1000_全部数据.xlsx',
    }))).toBe('index');
  });

  it('recognizes Nasdaq 100 by its unambiguous symbol', () => {
    expect(getDatasetAssetType(dataset({ symbol: 'NDX' }))).toBe('index');
  });

  it('defaults ambiguous legacy symbols to stock', () => {
    expect(getDatasetAssetType(dataset())).toBe('stock');
  });
});
