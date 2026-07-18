import { useEffect, useMemo, useState } from 'react';
import { App, Button, Drawer, Empty, Input, Space, Statistic, Table, Tag, Tooltip, Typography } from 'antd';
import { BankOutlined, ReloadOutlined, TrophyOutlined } from '@ant-design/icons';
import { apiFetch } from '../../api/client';
import type { DragonTigerMarketItem, DragonTigerMarketSnapshot, DragonTigerSeat, DragonTigerStockDetail, StockSearchItem } from './types';

const { Text } = Typography;
const STORAGE_KEY = 'quant-dragon-tiger-market-v1';

function readSnapshot(): DragonTigerMarketSnapshot | null {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as DragonTigerMarketSnapshot | null; } catch { return null; }
}

function amount(value: number | null): string {
  if (value == null) return '—';
  const abs = Math.abs(value);
  if (abs >= 100_000_000) return `${(value / 100_000_000).toLocaleString('zh-CN', { maximumFractionDigits: 2 })} 亿`;
  return `${(value / 10_000).toLocaleString('zh-CN', { maximumFractionDigits: 0 })} 万`;
}

export default function DragonTigerPanel({ onSelectStock }: { onSelectStock: (stock: StockSearchItem) => void }) {
  const { message } = App.useApp();
  const [snapshot, setSnapshot] = useState<DragonTigerMarketSnapshot | null>(readSnapshot);
  const [date, setDate] = useState(snapshot?.tradeDate ?? '');
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<DragonTigerMarketItem | null>(null);
  const [detail, setDetail] = useState<DragonTigerStockDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const load = async (force = false, targetDate = date) => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (targetDate) params.set('date', targetDate);
      if (force) params.set('force', 'true');
      const next = await apiFetch<DragonTigerMarketSnapshot>(`/api/market-data/dragon-tiger/market?${params}`, { timeoutMs: 60_000 });
      setSnapshot(next);
      setDate(next.tradeDate);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch (error) {
      message.warning(error instanceof Error ? error.message : '龙虎榜刷新失败，继续展示上次结果');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { if (!snapshot) void load(false, ''); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const uniqueStocks = useMemo(() => new Set((snapshot?.items ?? []).map((item) => item.code)).size, [snapshot]);
  const topNetBuy = useMemo(() => [...(snapshot?.items ?? [])].sort((a, b) => (b.netBuyAmt ?? -Infinity) - (a.netBuyAmt ?? -Infinity))[0], [snapshot]);

  const openDetail = async (item: DragonTigerMarketItem) => {
    setSelected(item);
    setDetail(null);
    setDetailLoading(true);
    try {
      setDetail(await apiFetch<DragonTigerStockDetail>(`/api/market-data/dragon-tiger/stocks/${item.code}`, { timeoutMs: 60_000 }));
    } catch (error) {
      message.error(error instanceof Error ? error.message : '席位明细加载失败');
    } finally {
      setDetailLoading(false);
    }
  };

  const seatColumns = [
    { title: '排名', dataIndex: 'rank', width: 64 },
    { title: '席位', dataIndex: 'seatName', render: (value: string, row: DragonTigerSeat) => <Space><span>{value}</span>{row.isInstitutional && <Tag color="gold">机构</Tag>}</Space> },
    { title: '买入', dataIndex: 'buyAmt', align: 'right' as const, render: amount },
    { title: '卖出', dataIndex: 'sellAmt', align: 'right' as const, render: amount },
    { title: '净额', dataIndex: 'netAmt', align: 'right' as const, render: (value: number | null) => <span className={(value ?? 0) >= 0 ? 'market-up' : 'market-down'}>{amount(value)}</span> },
  ];

  return <section className="dragon-tiger-panel" aria-label="全市场龙虎榜">
    <div className="market-intelligence-toolbar">
      <div><strong><TrophyOutlined /> 全市场龙虎榜</strong><Text type="secondary">同股同日多原因按事件分别保留</Text></div>
      <Space wrap>
        <Input type="date" aria-label="龙虎榜交易日" value={date} onChange={(event) => setDate(event.target.value)} onBlur={() => date && void load(false, date)} />
        <Tooltip title="强制刷新龙虎榜"><Button icon={<ReloadOutlined />} loading={loading} aria-label="刷新龙虎榜" onClick={() => void load(true)} /></Tooltip>
      </Space>
    </div>
    <div className="dragon-tiger-kpis">
      <Statistic title="上榜事件" value={snapshot?.total ?? 0} suffix="条" />
      <Statistic title="涉及股票" value={uniqueStocks} suffix="只" />
      <Statistic title="净买入居首" value={topNetBuy?.name ?? '—'} suffix={topNetBuy ? amount(topNetBuy.netBuyAmt) : undefined} />
      <Statistic title="数据日期" value={snapshot?.tradeDate ?? '—'} />
    </div>
    <Table<DragonTigerMarketItem>
      rowKey="tradeId"
      size="small"
      loading={loading}
      dataSource={snapshot?.items ?? []}
      pagination={{ pageSize: 20, showSizeChanger: false, showTotal: (total) => `共 ${total} 条事件` }}
      scroll={{ x: 1080 }}
      onRow={(row) => ({
        className: 'dragon-tiger-row', tabIndex: 0, 'aria-label': `查看${row.name}龙虎榜席位`,
        onClick: () => void openDetail(row),
        onKeyDown: (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); void openDetail(row); } },
      })}
      columns={[
        { title: '序号', dataIndex: 'rank', width: 66, fixed: 'left' },
        { title: '股票', width: 150, fixed: 'left', render: (_, row) => <div className="market-security-cell"><strong>{row.name}</strong><span>{row.code} · {row.exchange}</span></div> },
        { title: '涨跌幅', dataIndex: 'changePct', width: 90, align: 'right', render: (value) => <span className={(value ?? 0) >= 0 ? 'market-up' : 'market-down'}>{value == null ? '—' : `${value.toFixed(2)}%`}</span> },
        { title: '净买入', dataIndex: 'netBuyAmt', width: 120, align: 'right', sorter: (a, b) => (a.netBuyAmt ?? 0) - (b.netBuyAmt ?? 0), render: (value) => <span className={(value ?? 0) >= 0 ? 'market-up' : 'market-down'}>{amount(value)}</span> },
        { title: '买入额', dataIndex: 'buyAmt', width: 110, align: 'right', render: amount },
        { title: '卖出额', dataIndex: 'sellAmt', width: 110, align: 'right', render: amount },
        { title: '换手率', dataIndex: 'turnoverRate', width: 90, align: 'right', render: (value) => value == null ? '—' : `${value.toFixed(2)}%` },
        { title: '上榜原因', dataIndex: 'explanation', width: 330, ellipsis: true },
      ]}
      locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={loading ? '正在加载龙虎榜' : '该交易日暂无龙虎榜数据'} /> }}
    />
    <Drawer
      title={<Space><BankOutlined /><span>{selected?.name ?? '个股'}席位明细</span>{selected && <Tag>{selected.tradeDate}</Tag>}</Space>}
      open={selected != null}
      onClose={() => setSelected(null)}
      size="min(960px, 94vw)"
      loading={detailLoading}
      destroyOnHidden
      extra={selected && <Button onClick={() => onSelectStock({ code: selected.code, name: selected.name, market: selected.exchange, type: 'stock' })}>查看行情</Button>}
    >
      {(detail?.records ?? []).map((record) => <div className="dragon-tiger-event-detail" key={record.tradeId}>
        <div><strong>{record.tradeDate} · {record.explanation}</strong><Text type="secondary">净买入 {amount(record.netBuyAmt)}</Text></div>
        <Table<DragonTigerSeat> rowKey={(row) => `${row.tradeId}-${row.side}-${row.rank}-${row.seatName}`} size="small" pagination={false} dataSource={[...record.buySeats, ...record.sellSeats]} columns={[{ title: '方向', dataIndex: 'side', width: 66, render: (value) => <Tag color={value === 'buy' ? 'red' : 'green'}>{value === 'buy' ? '买' : '卖'}</Tag> }, ...seatColumns]} locale={{ emptyText: '席位尚未补齐' }} />
      </div>)}
      {!detailLoading && !detail?.records.length && <Empty description="暂无个股龙虎榜记录" />}
    </Drawer>
  </section>;
}
