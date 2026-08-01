export const WATCHLIST_PAGE_SIZE = 7;

export function paginateWatchlist<T>(
  items: T[],
  requestedPage: number,
  pageSize = WATCHLIST_PAGE_SIZE,
): { items: T[]; currentPage: number; pageCount: number } {
  const safePageSize = Math.max(1, Math.floor(pageSize));
  const pageCount = Math.max(1, Math.ceil(items.length / safePageSize));
  const currentPage = Math.min(Math.max(1, Math.floor(requestedPage)), pageCount);
  const start = (currentPage - 1) * safePageSize;
  return {
    items: items.slice(start, start + safePageSize),
    currentPage,
    pageCount,
  };
}
