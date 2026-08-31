import type { DatasetAssetType } from './datasetAssetType';

export function formatLibraryCount(value: number, noun = '条') {
  return `${value.toLocaleString()} ${noun}`;
}

export function getDatasetEmptyState(assetType: DatasetAssetType, filtered: boolean) {
  return filtered
    ? {
      title: '没有匹配的数据集',
      description: '试试名称、代码或清空搜索条件。',
    }
    : {
      title: `暂无${assetType === 'index' ? '指数' : '个股'}行情数据`,
      description: '导入或同步行情后，数据集会显示在这里。',
    };
}

export function getStockEmptyState(filtered: boolean) {
  return filtered
    ? {
      title: '没有匹配的证券',
      description: '调整代码、名称或行业筛选条件后再试。',
    }
    : {
      title: '暂无个股行情数据',
      description: '服务端历史库尚未返回可用证券数据。',
    };
}
