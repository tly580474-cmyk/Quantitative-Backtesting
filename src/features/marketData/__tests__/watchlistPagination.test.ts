import { describe, expect, it } from 'vitest';
import { paginateWatchlist, WATCHLIST_PAGE_SIZE } from '../watchlistPagination';

describe('watchlist pagination', () => {
  const watchlist = Array.from({ length: 11 }, (_, index) => `stock-${index + 1}`);

  it('loads seven stocks on the first page and the remainder on the second', () => {
    const first = paginateWatchlist(watchlist, 1);
    const second = paginateWatchlist(watchlist, 2);

    expect(WATCHLIST_PAGE_SIZE).toBe(7);
    expect(first.items).toEqual(watchlist.slice(0, 7));
    expect(second.items).toEqual(watchlist.slice(7));
    expect(first.pageCount).toBe(2);
  });

  it('clamps the current page after filtering or deleting stocks', () => {
    const result = paginateWatchlist(watchlist.slice(0, 6), 2);

    expect(result.currentPage).toBe(1);
    expect(result.items).toHaveLength(6);
  });
});
