export const RETURN_BASES = {
  rawStockPrice: {
    id: 'raw_stock_price_return',
    label: '股票不复权价格收益',
    description: '直接使用权威不复权 OHLC 计算，不包含公司行为调整。',
  },
  qfqAdjustedStockPrice: {
    id: 'qfq_adjusted_stock_price_return',
    label: '股票前复权价格收益',
    description: '使用 adjusted_price = raw_price * factor + priceOffset 计算。',
  },
  officialPriceIndex: {
    id: 'official_price_index_return',
    label: '官方价格指数收益',
    description: '直接使用官方指数点位计算，不能与股票前复权收益视为同一口径。',
  },
  constituentRebuiltQfq: {
    id: 'constituent_rebuilt_qfq_return',
    label: '成分前复权收益重建基准',
    description: '按历史成分与权重聚合股票前复权收益得到的研究基准。',
  },
} as const;

export type ReturnBasis = typeof RETURN_BASES[keyof typeof RETURN_BASES]['id'];

export function isReturnBasis(value: string): value is ReturnBasis {
  return Object.values(RETURN_BASES).some((basis) => basis.id === value);
}
