import type { MarketDataset } from '@/models';

export type DatasetAssetType = 'index' | 'stock';

const INDEX_HINTS = [
  '指数',
  '沪深300',
  '中证',
  '上证',
  '深证成指',
  '创业板指',
  '科创50',
  '科创综指',
  '纳斯达克100',
  'nasdaq 100',
  'nasdaq100',
];

export function getDatasetAssetType(dataset: MarketDataset): DatasetAssetType {
  if (dataset.assetType) return dataset.assetType;
  if (dataset.symbol.trim().toUpperCase() === 'NDX') return 'index';

  const searchable = `${dataset.name} ${dataset.sourceFileName ?? ''}`.toLowerCase();
  return INDEX_HINTS.some((hint) => searchable.includes(hint.toLowerCase()))
    ? 'index'
    : 'stock';
}

