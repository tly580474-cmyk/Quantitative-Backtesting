import { useState } from 'react';
import { Button, Drawer } from 'antd';
import {
  ApartmentOutlined,
  DownloadOutlined,
  FileSearchOutlined,
  MoreOutlined,
  ReloadOutlined,
  StarFilled,
  StarOutlined,
} from '@ant-design/icons';
import type { StockQuote } from './types';
import './mobile-detail-quote.css';

export interface MobileDetailQuoteProps {
  quote: StockQuote;
  inWatchlist: boolean;
  onAdd: () => void;
  onRefresh: () => void;
  refreshing: boolean;
  onExport: () => void;
  onAnalyze: () => void;
  exporting: boolean;
  onConstituents?: () => void;
}

interface MetricProps {
  label: string;
  value: string;
}

function number(value: number | null | undefined, digits = 2): string {
  return value == null || !Number.isFinite(value)
    ? '—'
    : value.toLocaleString('zh-CN', {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
}

function signedNumber(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${value > 0 ? '+' : ''}${number(value)}`;
}

function signedPercent(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${value > 0 ? '+' : ''}${number(value)}%`;
}

function changeClass(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value === 0) return 'is-flat';
  return value > 0 ? 'is-up' : 'is-down';
}

function amount(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return Math.abs(value) >= 10_000
    ? `${number(value / 10_000)} 亿`
    : `${number(value)} 万`;
}

function updatedLabel(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return '更新于 —';
  return `更新于 ${new Date(timestamp).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })}`;
}

function Metric({ label, value }: MetricProps) {
  return <div className="mobile-detail-quote__metric">
    <span>{label}</span>
    <strong>{value}</strong>
  </div>;
}

export default function MobileDetailQuote({
  quote,
  inWatchlist,
  onAdd,
  onRefresh,
  refreshing,
  onExport,
  onAnalyze,
  exporting,
  onConstituents,
}: MobileDetailQuoteProps) {
  const [moreOpen, setMoreOpen] = useState(false);
  const movementClass = changeClass(quote.changePct);

  const runAction = (action: () => void) => {
    setMoreOpen(false);
    action();
  };

  return <section className="mobile-detail-quote" aria-label={`${quote.name}行情`}>
    <div className="mobile-detail-quote__heading">
      <div className="mobile-detail-quote__identity">
        <strong>{quote.name}</strong>
        <span>{quote.code} · {quote.market}</span>
      </div>
      <div className="mobile-detail-quote__heading-actions">
        <Button
          type="text"
          className="mobile-detail-quote__icon-button"
          aria-label={inWatchlist ? '已在自选' : `添加${quote.name}到自选`}
          title={inWatchlist ? '已在自选' : '添加自选'}
          disabled={inWatchlist}
          icon={inWatchlist ? <StarFilled /> : <StarOutlined />}
          onClick={onAdd}
        />
        <Button
          type="text"
          className="mobile-detail-quote__icon-button"
          aria-label="更多行情操作"
          title="更多操作"
          icon={<MoreOutlined />}
          onClick={() => setMoreOpen(true)}
        />
      </div>
    </div>

    <div className={`mobile-detail-quote__price ${movementClass}`}>
      <strong>{number(quote.price)}</strong>
      <div className="mobile-detail-quote__change" aria-label="涨跌">
        <span>{signedNumber(quote.changeAmount)}</span>
        <span>{signedPercent(quote.changePct)}</span>
      </div>
      <span className="mobile-detail-quote__updated">{updatedLabel(quote.updatedAt)}</span>
    </div>

    <div className="mobile-detail-quote__metrics" aria-label="核心行情指标">
      <Metric label="今开" value={number(quote.open)} />
      <Metric label="最高" value={number(quote.high)} />
      <Metric label="最低" value={number(quote.low)} />
      <Metric label="成交额" value={amount(quote.amountWan)} />
      <Metric label="换手率" value={`${number(quote.turnoverPct)}%`} />
      <Metric label="量比" value={number(quote.volumeRatio)} />
    </div>

    <details className="mobile-detail-quote__more">
      <summary>更多行情</summary>
      <div className="mobile-detail-quote__more-grid">
        <Metric label="昨收" value={number(quote.previousClose)} />
        <Metric label="涨停" value={number(quote.limitUp)} />
        <Metric label="跌停" value={number(quote.limitDown)} />
        <Metric label="振幅" value={`${number(quote.amplitudePct)}%`} />
        <Metric label="PE(TTM)" value={number(quote.peTtm)} />
        <Metric label="PE(静)" value={number(quote.peStatic)} />
        <Metric label="PB" value={number(quote.pb)} />
        <Metric label="总市值" value={`${number(quote.marketCapYi)} 亿`} />
        <Metric label="流通市值" value={`${number(quote.floatMarketCapYi)} 亿`} />
        <Metric label="上市日期" value={quote.listDate || '—'} />
        <Metric label="所属行业" value={quote.industry || '—'} />
        <Metric label="数据来源" value={quote.source.length ? quote.source.join('、') : '—'} />
      </div>
    </details>

    <Drawer
      className="mobile-detail-quote-drawer"
      title="更多操作"
      placement="bottom"
      size="auto"
      open={moreOpen}
      onClose={() => setMoreOpen(false)}
      destroyOnHidden
    >
      <div className="mobile-detail-quote-drawer__actions">
        <Button
          block
          className="mobile-detail-quote-drawer__action"
          icon={<ReloadOutlined />}
          loading={refreshing}
          onClick={() => runAction(onRefresh)}
        >
          刷新行情
        </Button>
        <Button
          block
          className="mobile-detail-quote-drawer__action"
          icon={<DownloadOutlined />}
          loading={exporting}
          onClick={() => runAction(onExport)}
        >
          导出行情数据
        </Button>
        <Button
          block
          className="mobile-detail-quote-drawer__action"
          icon={<FileSearchOutlined />}
          onClick={() => runAction(onAnalyze)}
        >
          导入行情分析
        </Button>
        {onConstituents && <Button
          block
          className="mobile-detail-quote-drawer__action"
          icon={<ApartmentOutlined />}
          onClick={() => runAction(onConstituents)}
        >
          查看成分股
        </Button>}
      </div>
    </Drawer>
  </section>;
}
