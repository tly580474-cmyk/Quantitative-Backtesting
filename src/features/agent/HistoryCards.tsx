import { useState, type ReactNode } from 'react';
import { Pagination, Skeleton } from 'antd';

/** Mobile history keeps the same records and actions without a wide table. */
export default function HistoryCards<T>({ items, loading, empty, itemKey, renderItem }: {
  items: T[];
  loading: boolean;
  empty: ReactNode;
  itemKey: (item: T) => string;
  renderItem: (item: T) => ReactNode;
}) {
  const [page, setPage] = useState(1);
  const current = Math.min(page, Math.max(1, Math.ceil(items.length / 20)));
  if (!items.length) return loading ? <Skeleton active paragraph={{ rows: 5 }} /> : empty;
  return <div aria-busy={loading}>
    <ul className="agent-history-cards">
      {items.slice((current - 1) * 20, current * 20).map((item) => <li key={itemKey(item)}>{renderItem(item)}</li>)}
    </ul>
    <Pagination className="agent-history-pagination" current={current} pageSize={20}
      total={items.length} onChange={setPage} simple hideOnSinglePage showSizeChanger={false} />
  </div>;
}
