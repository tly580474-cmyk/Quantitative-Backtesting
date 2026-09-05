import { useEffect, useMemo } from 'react';
import { Alert, Button, Empty, Segmented, Skeleton, Space, Table, Tag, Tooltip, Typography } from 'antd';
import { PlusOutlined, ReloadOutlined, RightOutlined } from '@ant-design/icons';
import type {
  Csi1000LowPbSelectionBatch,
  Csi1000LowPbSelectionHistory,
  Csi1000LowPbSelectionItem,
  StockSearchItem,
} from '../marketData/types';

const { Text } = Typography;

interface Csi1000LowPbPanelProps {
  history: Csi1000LowPbSelectionHistory | null;
  loading: boolean;
  error: string | null;
  watchlist: StockSearchItem[];
  onRefresh: () => void;
  onAdd: (stock: StockSearchItem, price: number) => void;
  onOpenDetail: (stock: StockSearchItem) => void;
  selectedDate: string;
  onSelectedDateChange: (date: string) => void;
}

function signedPercent(value: number) {
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
}

function returnClass(value: number) {
  return value > 0 ? 'market-up' : value < 0 ? 'market-down' : '';
}

export default function Csi1000LowPbPanel({
  history,
  loading,
  error,
  watchlist,
  onRefresh,
  onAdd,
  onOpenDetail,
  selectedDate,
  onSelectedDateChange,
}: Csi1000LowPbPanelProps) {
  useEffect(() => {
    if (!history?.batches.length) return;
    if (!history.batches.some((batch) => batch.rebalanceDate === selectedDate)) {
      onSelectedDateChange(history.batches[0].rebalanceDate);
    }
  }, [history, onSelectedDateChange, selectedDate]);

  const batch = useMemo<Csi1000LowPbSelectionBatch | null>(
    () => history?.batches.find((item) => item.rebalanceDate === selectedDate)
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
    return <div className="selection-empty-state">
      {error && <Alert
        type="error"
        showIcon
        title="中证1000低PB结果加载失败"
        description={error}
        className="selection-load-error"
      />}
      <Empty
        description={error ? '请确认后端服务已更新并重试' : '暂无可用的中证1000低PB选股结果'}
        image={Empty.PRESENTED_IMAGE_SIMPLE}
      >
        <Button type="primary" icon={<ReloadOutlined />} loading={loading} onClick={onRefresh}>
          重新计算
        </Button>
      </Empty>
    </div>;
  }

  const dateOptions = history.batches.map((item, index) => ({
    value: item.rebalanceDate,
    label: (
      <span className="factor-date-option">
        <strong>{index === 0 ? '本期' : `前 ${index} 期`}</strong>
        <small>{item.rebalanceDate.slice(5)}</small>
      </span>
    ),
  }));

  return <div className="factor-selection-panel">
    <div className="factor-selection-toolbar">
      <div>
        <Space size={8} wrap>
          <Tag color="gold">{history.strategy}</Tag>
          <Tag>{history.methodology.rebalance} · {history.methodology.weighting}</Tag>
          <Text type="secondary">数据截至 {history.dataAsOf}</Text>
        </Space>
        <Tooltip title={`锁定 ${batch.constituentDate} 的真实中证1000成分快照，按正PB升序取前 ${history.methodology.selectionSize} 只。`}>
          <Text type="secondary">真实成分 · 低PB前 {history.methodology.selectionSize} 名</Text>
        </Tooltip>
      </div>
      <Tooltip title="基于当前研究快照重新计算">
        <Button icon={<ReloadOutlined />} loading={loading} onClick={onRefresh}>刷新结果</Button>
      </Tooltip>
    </div>

    <Alert
      type="warning"
      showIcon
      title="研究策略：费前回测不代表未来表现；组合最大回撤可能超过35%。"
      className="selection-research-alert"
    />

    <Segmented
      className="factor-date-switcher"
      block
      value={batch.rebalanceDate}
      options={dateOptions}
      onChange={(value) => onSelectedDateChange(String(value))}
      aria-label="选择中证1000低PB调仓期"
    />

    <div className="factor-selection-summary" aria-live="polite">
      <div><span>调仓日期</span><strong>{batch.rebalanceDate}</strong></div>
      <div><span>入选数量</span><strong>{batch.items.length}<small> 只</small></strong></div>
      <div><span>组合平均PB</span><strong>{batch.averagePb.toFixed(2)}<small> 倍</small></strong></div>
      <div><span>调仓后等权收益</span><strong className={returnClass(batch.averageReturnPct)}>{signedPercent(batch.averageReturnPct)}</strong></div>
    </div>

    <Table<Csi1000LowPbSelectionItem>
      className="factor-selection-table"
      size="small"
      rowKey="code"
      loading={loading}
      dataSource={batch.items}
      pagination={{ pageSize: 20, showSizeChanger: false, hideOnSinglePage: true }}
      scroll={{ x: 1120 }}
      rowClassName="factor-selection-row"
      onRow={(row) => ({
        tabIndex: 0,
        onDoubleClick: () => onOpenDetail({ code: row.code, name: row.name, market: row.market, type: 'stock' }),
        onKeyDown: (event) => {
          if (event.key === 'Enter') {
            onOpenDetail({ code: row.code, name: row.name, market: row.market, type: 'stock' });
          }
        },
      })}
      columns={[
        { title: '排名', dataIndex: 'rank', width: 70, render: (rank: number) => <b className="selection-rank">{rank}</b> },
        {
          title: '股票', width: 170, fixed: 'left', render: (_, row) => <button
            type="button"
            className="factor-stock-link"
            onClick={() => onOpenDetail({ code: row.code, name: row.name, market: row.market, type: 'stock' })}
          >
            <span><strong>{row.name}</strong><small>{row.code} · {row.market}</small></span>
            <RightOutlined />
          </button>,
        },
        { title: '行业', dataIndex: 'industry', width: 150, ellipsis: true },
        { title: 'PB', dataIndex: 'pb', width: 90, sorter: (a, b) => a.pb - b.pb, render: (value: number) => <strong className="factor-score">{value.toFixed(3)}</strong> },
        { title: '总市值', dataIndex: 'totalMarketCapYi', width: 110, sorter: (a, b) => a.totalMarketCapYi - b.totalMarketCapYi, render: (value: number) => `${value.toFixed(1)} 亿` },
        { title: '等权权重', dataIndex: 'portfolioWeightPct', width: 105, render: (value: number) => `${value.toFixed(2)}%` },
        { title: '入选价', dataIndex: 'selectedPrice', width: 95, render: (value: number) => value.toFixed(2) },
        { title: '最新价', dataIndex: 'latestPrice', width: 95, render: (value: number) => value.toFixed(2) },
        { title: '调仓后收益', dataIndex: 'returnSinceSelectionPct', width: 115, sorter: (a, b) => a.returnSinceSelectionPct - b.returnSinceSelectionPct, render: (value: number) => <strong className={returnClass(value)}>{signedPercent(value)}</strong> },
        {
          title: '操作', width: 102, fixed: 'right', render: (_, row) => {
            const exists = watchlistCodes.has(row.code);
            return <Button
              size="small"
              type="text"
              disabled={exists}
              icon={<PlusOutlined />}
              onClick={() => onAdd({ code: row.code, name: row.name, market: row.market, type: 'stock' }, row.latestPrice)}
            >
              {exists ? '已在自选' : '加自选'}
            </Button>;
          },
        },
      ]}
    />

    <div className="factor-method-note">
      <Text type="secondary">
        处理流程：{history.methodology.processing.join(' → ')}。成分快照：{batch.constituentSnapshotId.slice(0, 8)}…；结果未计交易成本与冲击成本。
      </Text>
    </div>
  </div>;
}
