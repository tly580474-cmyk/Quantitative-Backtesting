import { describe, expect, it } from 'vitest';
import {
  formatLibraryCount,
  getDatasetEmptyState,
  getStockEmptyState,
} from '../dataLibraryPresentation';

describe('data library presentation copy', () => {
  it('formats counts consistently for dense data rows', () => {
    expect(formatLibraryCount(12_345)).toBe('12,345 条');
    expect(formatLibraryCount(8, '只证券')).toBe('8 只证券');
  });

  it('distinguishes an empty dataset from a filtered result', () => {
    expect(getDatasetEmptyState('index', false)).toEqual({
      title: '暂无指数行情数据',
      description: '导入或同步行情后，数据集会显示在这里。',
    });
    expect(getDatasetEmptyState('stock', true).title).toBe('没有匹配的数据集');
  });

  it('keeps the stock empty-state explanation tied to the active filters', () => {
    expect(getStockEmptyState(false).title).toBe('暂无个股行情数据');
    expect(getStockEmptyState(true).description).toContain('行业筛选');
  });
});
