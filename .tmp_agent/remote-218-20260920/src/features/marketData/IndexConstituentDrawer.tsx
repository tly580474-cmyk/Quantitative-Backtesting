import { useEffect, useMemo, useState } from 'react';
import { App, Drawer, Empty, Input, Table, Tag, Typography } from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import { apiFetch } from '../../api/client';
import type {
  IndexConstituent,
  IndexConstituentSnapshot,
  StockSearchItem,
} from './types';

const { Text } = Typography;

interface IndexConstituentDrawerProps {
  index: Pick<StockSearchItem, 'code' | 'name'>;
  open: boolean;
  onClose: () => void;
  onSelectStock: (stock: StockSearchItem) => void;
}

function marketOfCode(code: string): StockSearchItem['market'] {
  if (/^(4|8|92)/.test(code)) return 'BJ';
  return /^(6|9)/.test(code) ? 'SH' : 'SZ';
}

function weightText(value: number | null) {
  return value == null ? '—' : `${value.toLocaleString('zh-CN', { maximumFractionDigits: 4 })}%`;
}

export default function IndexConstituentDrawer({
  index,
  open,
  onClose,
  onSelectStock,
}: IndexConstituentDrawerProps) {
  const { message } = App.useApp();
  const [snapshot, setSnapshot] = useState<IndexConstituentSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setQuery('');
    setSnapshot(null);
    void apiFetch<IndexConstituentSnapshot>(
      `/api/research-snapshots/index-constituents/${encodeURIComponent(index.code)}`,
      { timeoutMs: 30_000 },
    ).then((data) => {
      if (!cancelled) setSnapshot(data);
    }).catch((error) => {
      if (!cancelled) {
        message.error(error instanceof Error ? error.message : '指数成分股加载失败');
      }
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [index.code, message, open]);

  const items = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    const source = snapshot?.items ?? [];
    if (!keyword) return source;
    return source.filter((item) => (
      item.code.includes(keyword)
      || item.name.toLowerCase().includes(keyword)
      || (item.nameEn?.toLowerCase().includes(keyword) ?? false)
    ));
  }, [query, snapshot]);

  const selectStock = (item: IndexConstituent) => {
    onSelectStock({
      code: item.code,
      name: item.name,
      market: marketOfCode(item.code),
      type: 'stock',
    });
    onClose();
  };

  return <Drawer
    className="sector-constituent-drawer"
    title={<div className="sector-constituent-title">
      <span>{snapshot?.indexName ?? index.name}成分股</span>
      <Tag color="blue">指数</Tag>
    </div>}
    open={open}
    onClose={onClose}
    size="min(900px, 92vw)"
    destroyOnHidden
  >
    <div className="sector-constituent-toolbar">
      <div>
        <Text strong>{index.code}</Text>
        <Text type="secondary">
          {snapshot?.total
            ? `${snapshot.total} 只成分股 · 成分日期 ${snapshot.constituentDate} · ${snapshot.source} · 点击股票查看行情详情`
            : loading ? '正在读取最新成分快照' : '本地研究快照暂无该指数成分数据'}
        </Text>
      </div>
      <Input
        allowClear
        prefix={<SearchOutlined />}
        placeholder="搜索股票名称、英文名或代码"
        aria-label={`搜索${index.name}成分股`}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
    </div>
    <Table<IndexConstituent>
      className="sector-constituent-table"
      size="small"
      rowKey="code"
      loading={loading}
      dataSource={items}
      pagination={{
        pageSize: 20,
        showSizeChanger: false,
        showTotal: (total) => `共 ${total} 只`,
      }}
      scroll={{ x: 660 }}
      onRow={(row) => ({
        className: 'sector-constituent-row',
        tabIndex: 0,
        'aria-label': `查看${row.name}行情详情`,
        onClick: () => selectStock(row),
        onKeyDown: (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            selectStock(row);
          }
        },
      })}
      columns={[
        { title: '序号', dataIndex: 'rank', width: 68 },
        {
          title: '股票',
          fixed: 'left',
          width: 190,
          render: (_, row) => <div className="selection-stock-cell">
            <strong>{row.name}</strong>
            <span>{row.code}</span>
          </div>,
        },
        {
          title: '英文简称',
          dataIndex: 'nameEn',
          width: 220,
          ellipsis: true,
          render: (value: string | null) => value || '—',
        },
        {
          title: '交易所',
          dataIndex: 'exchange',
          width: 150,
          render: (value: string | null) => value || '—',
        },
        {
          title: '权重',
          dataIndex: 'weightPct',
          width: 92,
          align: 'right',
          sorter: (left, right) => (left.weightPct ?? -Infinity) - (right.weightPct ?? -Infinity),
          render: weightText,
        },
      ]}
      locale={{
        emptyText: <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={loading ? '正在加载成分股' : query ? '没有匹配的成分股' : '暂无成分股数据'}
        />,
      }}
    />
  </Drawer>;
}
