import { useState, type ReactNode } from 'react';
import { Button, Drawer, Empty, Input, Popconfirm } from 'antd';
import { DeleteOutlined, PlusOutlined, PushpinOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { buildMarketIndexDetailTarget, type MarketIndexCardView } from './marketIndexCards';
import { calculateWatchlistMetrics } from './watchlistMetrics';
import { useWatchlistQuotes } from './useWatchlistQuotes';
import type { StockSearchItem } from './types';
import './mobile-watchlist.css';

interface Props {
  watchlist: StockSearchItem[];
  indexCards: MarketIndexCardView[];
  indexLoading: boolean;
  onRefreshIndices: () => Promise<void>;
  onOpenDetail: (stock: StockSearchItem) => void;
  onRemove: (code: string) => void;
  pinnedCodes: string[];
  onTogglePin: (code: string) => void;
  addSearch: ReactNode;
}

function number(value: number | null | undefined) {
  return value != null && Number.isFinite(value) ? value.toFixed(2) : '—';
}
function percent(value: number | null | undefined, signed = true) {
  return value != null && Number.isFinite(value)
    ? `${signed && value > 0 ? '+' : ''}${value.toFixed(2)}%` : '—';
}
function direction(value: number | null | undefined) {
  return value != null && Number.isFinite(value) && value !== 0 ? (value > 0 ? 'is-up' : 'is-down') : '';
}

export default function MobileWatchlist({ watchlist, indexCards, indexLoading, onRefreshIndices,
  onOpenDetail, onRemove, pinnedCodes, onTogglePin, addSearch }: Props) {
  const [query, setQuery] = useState('');
  const [managing, setManaging] = useState(false);
  const [adding, setAdding] = useState(false);
  const { quotes, loading, failedCodes, refresh } = useWatchlistQuotes(watchlist.map(item => item.code));
  const search = query.trim().toLowerCase();
  const visible = watchlist.filter(item => `${item.name} ${item.code}`.toLowerCase().includes(search));

  return <main className="mobile-watchlist-page" aria-label="我的自选证券列表">
    <section className="mobile-watchlist-indices" aria-label="主要指数">
      {indexCards.map(({ key, option, quote }) => <button key={key} type="button"
        aria-label={`查看${option.name}行情`} onClick={() => onOpenDetail(buildMarketIndexDetailTarget(option, quote))}>
        <span>{option.name}</span>
        <strong className={direction(quote?.changePct)}>{number(quote?.price)}</strong>
        <small className={direction(quote?.changePct)}>{percent(quote?.changePct)}</small>
      </button>)}
    </section>

    <div className="mobile-watchlist-tools">
      <Input prefix={<SearchOutlined />} allowClear value={query} aria-label="搜索我的自选"
        placeholder={`搜索自选 (${watchlist.length})`} onChange={event => setQuery(event.target.value)} />
      <Button type="text" icon={<PlusOutlined />} aria-label="添加自选" onClick={() => setAdding(true)} />
      <Button type="text" icon={<ReloadOutlined />} aria-label="刷新自选及指数" loading={loading || indexLoading}
        onClick={() => { void refresh(); void onRefreshIndices(); }} />
      <Button type="text" aria-pressed={managing} onClick={() => setManaging(!managing)}>{managing ? '完成' : '管理'}</Button>
    </div>
    <div className="mobile-watchlist-columns" aria-hidden="true">
      <span>证券</span><span>价格<small>换手率</small></span><span>涨跌幅<small>自选后收益</small></span>
    </div>
    {failedCodes.length > 0 && <p className="mobile-watchlist-status" role="status">
      {failedCodes.length} 只证券刷新失败，保留上次行情，可点刷新重试。
    </p>}
    {visible.length ? <ul className="mobile-watchlist-list" aria-label="自选证券">
      {visible.map(item => {
        const quote = quotes[item.code];
        const metrics = calculateWatchlistMetrics(item, quote, []);
        return <li key={item.code}>
          <button type="button" className="mobile-watchlist-row" aria-label={`查看${item.name}详情`}
            onClick={() => onOpenDetail(item)}>
            <span className="mobile-watchlist-name"><strong>{item.name}</strong><small>{item.code}
              {pinnedCodes.includes(item.code) && <PushpinOutlined aria-label="已置顶" />}</small></span>
            <span className="mobile-watchlist-value"><strong className={direction(quote?.changePct)}>{number(quote?.price)}</strong>
              <small aria-label="换手率">{percent(quote?.turnoverPct, false)}</small></span>
            <span className="mobile-watchlist-value"><strong className={direction(quote?.changePct)}>{percent(quote?.changePct)}</strong>
              <small aria-label="自选后收益" className={direction(metrics.returnSinceAddedPct)}
                title={item.addedPrice == null ? '缺少加入时价格，无法计算自选后收益' : '相对加入自选时价格的收益率'}>{percent(metrics.returnSinceAddedPct)}</small></span>
          </button>
          {managing && <div className="mobile-watchlist-row-actions">
            <Button size="small" icon={<PushpinOutlined />} onClick={() => onTogglePin(item.code)}>
              {pinnedCodes.includes(item.code) ? '取消置顶' : '置顶'}</Button>
            <Popconfirm title={`将${item.name}移出自选？`} okText="移出" cancelText="取消" onConfirm={() => onRemove(item.code)}>
              <Button danger size="small" icon={<DeleteOutlined />} aria-label={`移除${item.name}`}>移出自选</Button>
            </Popconfirm>
          </div>}
        </li>;
      })}
    </ul> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE}
      description={watchlist.length ? '未找到匹配的自选股' : '暂无自选证券'}>
      {!watchlist.length && <Button type="primary" onClick={() => setAdding(true)}>添加第一只证券</Button>}
    </Empty>}
    <Drawer title="添加自选" placement="bottom" size="85dvh" open={adding} onClose={() => setAdding(false)}>
      <div className="mobile-watchlist-add-search">{addSearch}</div>
    </Drawer>
  </main>;
}
