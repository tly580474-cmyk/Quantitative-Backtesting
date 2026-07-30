import { useEffect, useMemo, useState } from 'react';
import { Button, Empty, Segmented, Skeleton, Space, Table, Tag, Tooltip, Typography } from 'antd';
import { PlusOutlined, ReloadOutlined, RightOutlined } from '@ant-design/icons';
import type {
  FactorSelectionBatch,
  FactorSelectionHistory,
  FactorSelectionItem,
  StockSearchItem,
} from '../marketData/types';

const { Text } = Typography;

interface FactorSelectionPanelProps {
  history: FactorSelectionHistory | null;
  loading: boolean;
  watchlist: StockSearchItem[];
  onRefresh: () => void;
  onAdd: (stock: StockSearchItem, price: number) => void;
  onOpenDetail: (stock: StockSearchItem) => void;
}

function signedPercent(value: number) {
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
}

function returnClass(value: number) {
  return value > 0 ? 'market-up' : value < 0 ? 'market-down' : '';
}

export default function FactorSelectionPanel({
  history,
  loading,
  watchlist,
  onRefresh,
  onAdd,
  onOpenDetail,
}: FactorSelectionPanelProps) {
  const [selectedDate, setSelectedDate] = useState('');

  useEffect(() => {
    if (!history?.batches.length) return;
    if (!history.batches.some((batch) => batch.tradeDate === selectedDate)) {
      setSelectedDate(history.batches[0].tradeDate);
    }
  }, [history, selectedDate]);

  const batch = useMemo<FactorSelectionBatch | null>(
    () => history?.batches.find((item) => item.tradeDate === selectedDate)
      ?? history?.batches[0]
      ?? null,
    [history, selectedDate],
  );
  const watchlistCodes = useMemo(() => new Set(watchlist.map((item) => item.code)), [watchlist]);

  if (loading && !history) {
    return <div className="factor-selection-loading" aria-live="polite">
      <Skeleton active paragraph={{ rows: 8 }} />
    </div>;
  }

  if (!history || !batch) {
    return <Empty
      description="暂无可用的 13 因子选股结果"
      image={Empty.PRESENTED_IMAGE_SIMPLE}
    >
      <Button type="primary" icon={<ReloadOutlined />} loading={loading} onClick={onRefresh}>
        重新计算
      </Button>
    </Empty>;
  }

  const dateOptions = history.batches.map((item, index) => ({
    value: item.tradeDate,
    label: (
      <span className="factor-date-option">
        <strong>{index === 0 ? '今日' : `前 ${index} 日`}</strong>
        <small>{item.tradeDate.slice(5)}</small>
      </span>
    ),
  }));

  return <div className="factor-selection-panel">
    <div className="factor-selection-toolbar">
      <div>
        <Space size={8} wrap>
          <Tag color="blue">{history.strategy}</Tag>
          <Text type="secondary">数据截至 {history.dataAsOf}</Text>
        </Space>
        <Text type="secondary">
          选取综合得分前 {history.methodology.selectionSize} 名；保留今日及此前 5 个交易日，收益按入选收盘价至最新收盘价计算。
        </Text>
      </div>
      <Tooltip title="基于当前研究快照重新计算">
        <Button icon={<ReloadOutlined />} loading={loading} onClick={onRefresh}>刷新结果</Button>
      </Tooltip>
    </div>

    <Segmented
      className="factor-date-switcher"
      block
      value={batch.tradeDate}
      options={dateOptions}
      onChange={(value) => setSelectedDate(String(value))}
      aria-label="选择因子选股交易日"
    />

    <div className="factor-selection-summary" aria-live="polite">
      <div><span>选股日期</span><strong>{batch.tradeDate}</strong></div>
      <div><span>入选数量</span><strong>{batch.items.length}<small> 只</small></strong></div>
      <div><span>平均入选收益</span><strong className={returnClass(batch.averageReturnPct)}>{signedPercent(batch.averageReturnPct)}</strong></div>
      <div><span>上涨数量</span><strong>{batch.positiveCount}<small> / {batch.items.length}</small></strong></div>
    </div>

    <Table<FactorSelectionItem>
      className="factor-selection-table"
      size="small"
      rowKey="code"
      loading={loading}
      dataSource={batch.items}
      pagination={{ pageSize: 20, showSizeChanger: false, hideOnSinglePage: true }}
      scroll={{ x: 1000 }}
      rowClassName="factor-selection-row"
      onRow={(row) => ({
        tabIndex: 0,
        onDoubleClick: () => onOpenDetail({
          code: row.code,
          name: row.name,
          market: row.market,
          type: 'stock',
        }),
        onKeyDown: (event) => {
          if (event.key === 'Enter') {
            onOpenDetail({ code: row.code, name: row.name, market: row.market, type: 'stock' });
          }
        },
      })}
      columns={[
        { title: '排名', dataIndex: 'rank', width: 70, render: (rank: number) => <b className="selection-rank">{rank}</b> },
        {
          title: '股票',
          width: 170,
          fixed: 'left',
          render: (_, row) => <button
            type="button"
            className="factor-stock-link"
            onClick={() => onOpenDetail({ code: row.code, name: row.name, market: row.market, type: 'stock' })}
          >
            <span><strong>{row.name}</strong><small>{row.code} · {row.market}</small></span>
            <RightOutlined />
          </button>,
        },
        { title: '行业', dataIndex: 'industry', width: 150, ellipsis: true },
        {
          title: '综合得分',
          dataIndex: 'selectionScore',
          width: 105,
          sorter: (a, b) => a.selectionScore - b.selectionScore,
          render: (value: number) => <strong className="factor-score">{value.toFixed(4)}</strong>,
        },
        { title: '有效因子', dataIndex: 'factorCount', width: 90, render: (value: number) => `${value} / 13` },
        { title: '入选价', dataIndex: 'selectedPrice', width: 95, render: (value: number) => value.toFixed(2) },
        { title: '最新价', dataIndex: 'latestPrice', width: 95, render: (value: number) => value.toFixed(2) },
        {
          title: '入选收益',
          dataIndex: 'returnSinceSelectionPct',
          width: 110,
          sorter: (a, b) => a.returnSinceSelectionPct - b.returnSinceSelectionPct,
          render: (value: number) => <strong className={returnClass(value)}>{signedPercent(value)}</strong>,
        },
        { title: '财务数据截至', dataIndex: 'financialAsOf', width: 120, render: (value: string | null) => value ?? '—' },
        {
          title: '操作',
          width: 102,
          fixed: 'right',
          render: (_, row) => {
            const exists = watchlistCodes.has(row.code);
            return <Button
              size="small"
              type={exists ? 'default' : 'primary'}
              disabled={exists}
              icon={<PlusOutlined />}
              onClick={() => onAdd({
                code: row.code,
                name: row.name,
                market: row.market,
                type: 'stock',
              }, row.latestPrice)}
            >
              {exists ? '已在自选' : '加自选'}
            </Button>;
          },
        },
      ]}
    />

    <div className="factor-method-note">
      <Text type="secondary">
        处理流程：{history.methodology.processing.join(' → ')}。今日批次尚无持有期，因此入选收益显示为 0。
      </Text>
    </div>
  </div>;
}
