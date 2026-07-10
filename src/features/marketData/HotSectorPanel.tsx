import { useEffect, useMemo, useState } from 'react';
import { App, Button, Drawer, Empty, Input, Progress, Segmented, Space, Table, Tag, Tooltip, Typography } from 'antd';
import { FireOutlined, ReloadOutlined, RightOutlined, SearchOutlined } from '@ant-design/icons';
import { apiFetch } from '../../api/client';
import type { HotSectorItem, HotSectorSnapshot, SectorConstituent, SectorConstituentSnapshot, StockSearchItem } from './types';

const { Text } = Typography;
const STORAGE_KEY = 'quant-hot-sector-snapshot-v1';

function readSnapshot(): HotSectorSnapshot | null {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as HotSectorSnapshot | null;
  } catch {
    return null;
  }
}

function numberText(value: number | null, suffix = '') {
  return value == null ? '—' : `${value.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}${suffix}`;
}

function signed(value: number | null, suffix = '') {
  if (value == null) return '—';
  return `${value > 0 ? '+' : ''}${numberText(value, suffix)}`;
}

function scoreColor(score: number) {
  if (score >= 80) return '#dc2626';
  if (score >= 65) return '#d97706';
  return '#2563eb';
}

function marketOfCode(code: string): StockSearchItem['market'] {
  if (/^[689]/.test(code)) return 'SH';
  if (/^[48]/.test(code)) return 'BJ';
  return 'SZ';
}

interface HotSectorPanelProps {
  onSelectStock: (stock: StockSearchItem) => void;
}

export default function HotSectorPanel({ onSelectStock }: HotSectorPanelProps) {
  const { message } = App.useApp();
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [scope, setScope] = useState<'all' | 'industry' | 'concept'>('all');
  const [snapshot, setSnapshot] = useState<HotSectorSnapshot | null>(readSnapshot);
  const [selectedSector, setSelectedSector] = useState<HotSectorItem | null>(null);
  const [constituents, setConstituents] = useState<SectorConstituentSnapshot | null>(null);
  const [constituentsLoading, setConstituentsLoading] = useState(false);
  const [constituentQuery, setConstituentQuery] = useState('');

  const load = async (force = false) => {
    setLoading(true);
    try {
      const next = await apiFetch<HotSectorSnapshot>(`/api/market-data/hot-sectors${force ? '?force=true' : ''}`, {
        timeoutMs: 60000,
      });
      setSnapshot(next);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch (error) {
      message.warning(error instanceof Error ? error.message : '热门板块刷新失败，继续展示上次结果');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!snapshot) void load(false);
    // The initial snapshot request is intentionally mount-only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const items = useMemo(() => {
    const source = snapshot?.items ?? [];
    return (scope === 'all' ? source : source.filter((item) => item.type === scope)).slice(0, 50);
  }, [scope, snapshot]);
  const leaders = items.slice(0, 3);
  const industryLeaders = useMemo(() => (snapshot?.items ?? []).filter((item) => item.type === 'industry').slice(0, 5), [snapshot]);
  const conceptLeaders = useMemo(() => (snapshot?.items ?? []).filter((item) => item.type === 'concept').slice(0, 5), [snapshot]);
  const filteredConstituents = useMemo(() => {
    const query = constituentQuery.trim().toLowerCase();
    const source = constituents?.items ?? [];
    return query
      ? source.filter((item) => item.code.includes(query) || item.name.toLowerCase().includes(query))
      : source;
  }, [constituentQuery, constituents]);

  const showConstituents = async (sector: HotSectorItem) => {
    setSelectedSector(sector);
    setConstituentQuery('');
    setConstituents(null);
    setConstituentsLoading(true);
    try {
      const data = await apiFetch<SectorConstituentSnapshot>(
        `/api/market-data/hot-sectors/${encodeURIComponent(sector.code)}/constituents?name=${encodeURIComponent(sector.name)}`,
        { timeoutMs: 30000 },
      );
      setConstituents(data);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '板块成分股加载失败');
    } finally {
      setConstituentsLoading(false);
    }
  };

  const selectConstituent = (stock: SectorConstituent) => {
    onSelectStock({
      code: stock.code,
      name: stock.name,
      market: marketOfCode(stock.code),
      type: 'stock',
    });
    setSelectedSector(null);
  };

  const compactRanking = (title: string, rows: HotSectorItem[]) => <div className="hot-sector-ranking">
    <div className="hot-sector-ranking-head"><strong>{title}</strong><span>涨跌幅</span><span>主力净流入</span></div>
    <div className="hot-sector-ranking-body">
      {rows.map((item, index) => <button type="button" key={`${item.type}-${item.code}`} onClick={() => void showConstituents(item)} aria-label={`查看${item.name}板块成分股`}>
        <b className={index < 3 ? 'is-leading' : ''}>{index + 1}</b>
        <span><strong>{item.name}</strong><small>{item.leadingStock ? `领涨 ${item.leadingStock}` : item.code}</small></span>
        <em className={(item.changePct ?? 0) >= 0 ? 'market-up' : 'market-down'}>{signed(item.changePct, '%')}</em>
        <em className={(item.mainNetInYi ?? 0) >= 0 ? 'market-up' : 'market-down'}>{signed(item.mainNetInYi, ' 亿')}</em>
      </button>)}
      {!rows.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={loading ? '正在加载板块榜单' : '暂无板块数据'} />}
    </div>
  </div>;

  const content = <div className="hot-sector-panel">
    <div className="hot-sector-toolbar">
      <Segmented
        value={scope}
        onChange={(value) => setScope(value as typeof scope)}
        options={[
          { label: '全部', value: 'all' },
          { label: '行业', value: 'industry' },
          { label: '概念', value: 'concept' },
        ]}
      />
      {snapshot && <Text type="secondary">{new Date(snapshot.updatedAt).toLocaleString('zh-CN')} · {snapshot.source}</Text>}
    </div>
    {leaders.length > 0 && <div className="hot-sector-leaders">
      {leaders.map((item) => <button
        type="button"
        className="hot-sector-leader-card"
        key={`${item.type}-${item.code}`}
        onClick={() => void showConstituents(item)}
        aria-label={`查看${item.name}板块成分股`}
      >
        <div><b>TOP {item.rank}</b><Tag color={item.type === 'industry' ? 'blue' : 'purple'}>{item.type === 'industry' ? '行业' : '概念'}</Tag></div>
        <strong>{item.name}</strong>
        <div className="hot-sector-leader-metrics">
          <span className={(item.changePct ?? 0) >= 0 ? 'market-up' : 'market-down'}>{signed(item.changePct, '%')}</span>
          <small>主力 {signed(item.mainNetInYi, ' 亿')}</small>
        </div>
        <Progress percent={item.heatScore} showInfo={false} strokeColor={scoreColor(item.heatScore)} railColor="#e2e8f0" size="small" />
        <span className="hot-sector-card-footer"><Text type="secondary">热度 {item.heatScore}</Text><Text type="secondary">查看成分股 <RightOutlined /></Text></span>
      </button>)}
    </div>}
    <Table<HotSectorItem>
      size="small"
      rowKey={(row) => `${row.type}-${row.code}`}
      loading={loading}
      dataSource={items}
      pagination={{ pageSize: 10, hideOnSinglePage: true, responsive: true }}
      scroll={{ x: 1050 }}
      onRow={(row) => ({
        className: 'hot-sector-table-row',
        tabIndex: 0,
        'aria-label': `查看${row.name}板块成分股`,
        onClick: () => void showConstituents(row),
        onKeyDown: (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            void showConstituents(row);
          }
        },
      })}
      columns={[
        { title: '排名', dataIndex: 'rank', width: 64, render: (rank: number) => <b className="hot-sector-rank">{rank}</b> },
        { title: '板块', width: 170, render: (_, row) => <div className="hot-sector-name-cell"><strong>{row.name}</strong><span>{row.code} · {row.type === 'industry' ? '行业' : '概念'}</span></div> },
        {
          title: '热度',
          dataIndex: 'heatScore',
          width: 92,
          sorter: (a, b) => a.heatScore - b.heatScore,
          render: (score: number, row) => <Tooltip title={`动量 ${row.scoreDetail.momentum} · 资金 ${row.scoreDetail.capital} · 广度 ${row.scoreDetail.breadth} · 活跃 ${row.scoreDetail.activity} · 持续 ${row.scoreDetail.persistence}`}>
            <Tag color={score >= 80 ? 'red' : score >= 65 ? 'orange' : 'blue'}>{score}</Tag>
          </Tooltip>,
        },
        { title: '涨跌幅', dataIndex: 'changePct', width: 90, render: (value) => <span className={(value ?? 0) >= 0 ? 'market-up' : 'market-down'}>{signed(value, '%')}</span> },
        { title: '主力净流入', dataIndex: 'mainNetInYi', width: 116, render: (value) => signed(value, ' 亿') },
        { title: '净流入占比', dataIndex: 'mainNetRatio', width: 104, render: (value) => signed(value, '%') },
        { title: '上涨广度', dataIndex: 'breadthPct', width: 96, render: (value, row) => <Tooltip title={`上涨 ${row.advancers ?? '—'} / 下跌 ${row.decliners ?? '—'}`}>{numberText(value, '%')}</Tooltip> },
        { title: '领涨股', width: 140, render: (_, row) => row.leadingStock ? <span>{row.leadingStock} <Text type="secondary">{signed(row.leadingStockChangePct, '%')}</Text></span> : '—' },
        { title: '信号', dataIndex: 'signals', width: 230, render: (signals: string[]) => <Space size={[0, 4]} wrap>{signals.map((signal) => <Tag key={signal}>{signal}</Tag>)}</Space> },
      ]}
      locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={loading ? '正在计算板块热度' : '暂无热门板块数据，可点击刷新'} /> }}
    />
  </div>;

  return <section className="hot-sector-section" aria-label="当日热门板块">
    <div className="hot-sector-dashboard">
      <div className="hot-sector-dashboard-head">
        <div><strong><FireOutlined />热门板块 Top10</strong>{snapshot && <Text type="secondary">{new Date(snapshot.updatedAt).toLocaleString('zh-CN')} · {snapshot.source}</Text>}</div>
        <Space><Button size="small" type="text" icon={<ReloadOutlined />} loading={loading} aria-label="刷新热门板块" onClick={() => void load(true)} /><Button size="small" onClick={() => setExpanded((value) => !value)}>{expanded ? '收起完整榜单' : '查看完整榜单'}</Button></Space>
      </div>
      <div className="hot-sector-ranking-grid">
        {compactRanking('行业涨跌幅 Top5', industryLeaders)}
        {compactRanking('概念板块 Top5', conceptLeaders)}
      </div>
      {expanded && <div className="hot-sector-expanded">{content}</div>}
    </div>
    <Drawer
      className="sector-constituent-drawer"
      title={<div className="sector-constituent-title"><span>{selectedSector?.name ?? '板块'}成分股</span>{selectedSector && <Tag color={selectedSector.type === 'industry' ? 'blue' : 'purple'}>{selectedSector.type === 'industry' ? '行业' : '概念'}</Tag>}</div>}
      open={selectedSector != null}
      onClose={() => setSelectedSector(null)}
      size="min(900px, 92vw)"
      destroyOnHidden
    >
      <div className="sector-constituent-toolbar">
        <div>
          <Text strong>{selectedSector?.code}</Text>
          <Text type="secondary">{constituents ? `${constituents.total} 只成分股 · ${new Date(constituents.updatedAt).toLocaleString('zh-CN')} · 点击股票查看行情详情` : '按当日涨跌幅排序'}</Text>
        </div>
        <Input
          allowClear
          prefix={<SearchOutlined />}
          placeholder="搜索股票名称或代码"
          aria-label="搜索板块成分股"
          value={constituentQuery}
          onChange={(event) => setConstituentQuery(event.target.value)}
        />
      </div>
      <Table<SectorConstituent>
        className="sector-constituent-table"
        size="small"
        rowKey="code"
        loading={constituentsLoading}
        dataSource={filteredConstituents}
        pagination={{ pageSize: 15, showSizeChanger: false, showTotal: (total) => `共 ${total} 只` }}
        scroll={{ x: 860 }}
        onRow={(row) => ({
          className: 'sector-constituent-row',
          tabIndex: 0,
          'aria-label': `查看${row.name}行情详情`,
          onClick: () => selectConstituent(row),
          onKeyDown: (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              selectConstituent(row);
            }
          },
        })}
        columns={[
          { title: '序号', dataIndex: 'rank', width: 64 },
          { title: '股票', fixed: 'left', width: 132, render: (_, row) => <div className="selection-stock-cell"><strong>{row.name}</strong><span>{row.code}</span></div> },
          { title: '最新价', dataIndex: 'price', width: 84, align: 'right', render: (value) => numberText(value) },
          { title: '涨跌幅', dataIndex: 'changePct', width: 88, align: 'right', sorter: (a, b) => (a.changePct ?? -Infinity) - (b.changePct ?? -Infinity), render: (value) => <span className={(value ?? 0) >= 0 ? 'market-up' : 'market-down'}>{signed(value, '%')}</span> },
          { title: '成交额', dataIndex: 'amountYi', width: 94, align: 'right', sorter: (a, b) => (a.amountYi ?? 0) - (b.amountYi ?? 0), render: (value) => numberText(value, ' 亿') },
          { title: '换手率', dataIndex: 'turnoverPct', width: 88, align: 'right', render: (value) => numberText(value, '%') },
          { title: '量比', dataIndex: 'volumeRatio', width: 76, align: 'right', render: (value) => numberText(value) },
          { title: '主力净流入', dataIndex: 'mainNetInYi', width: 112, align: 'right', sorter: (a, b) => (a.mainNetInYi ?? 0) - (b.mainNetInYi ?? 0), render: (value) => <span className={(value ?? 0) >= 0 ? 'market-up' : 'market-down'}>{signed(value, ' 亿')}</span> },
          { title: '净流入占比', dataIndex: 'mainNetRatio', width: 104, align: 'right', render: (value) => signed(value, '%') },
        ]}
        locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={constituentsLoading ? '正在加载成分股' : constituentQuery ? '没有匹配的成分股' : '暂无成分股数据'} /> }}
      />
    </Drawer>
  </section>;
}
