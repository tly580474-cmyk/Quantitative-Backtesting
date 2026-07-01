import { useMemo, useState } from 'react';
import { App, Button, Collapse, Empty, Progress, Segmented, Space, Table, Tag, Tooltip, Typography } from 'antd';
import { FireOutlined, ReloadOutlined } from '@ant-design/icons';
import { apiFetch } from '../../api/client';
import type { HotSectorItem, HotSectorSnapshot } from './types';

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

export default function HotSectorPanel() {
  const { message } = App.useApp();
  const [open, setOpen] = useState(false);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [loading, setLoading] = useState(false);
  const [scope, setScope] = useState<'all' | 'industry' | 'concept'>('all');
  const [snapshot, setSnapshot] = useState<HotSectorSnapshot | null>(readSnapshot);

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
      setLoadedOnce(true);
    }
  };

  const handleChange = (keys: string | string[]) => {
    const activeKeys = Array.isArray(keys) ? keys : [keys];
    const nextOpen = activeKeys.includes('hot-sectors');
    setOpen(nextOpen);
    if (nextOpen && !loadedOnce) void load(false);
  };

  const items = useMemo(() => {
    const source = snapshot?.items ?? [];
    return (scope === 'all' ? source : source.filter((item) => item.type === scope)).slice(0, 50);
  }, [scope, snapshot]);
  const leaders = items.slice(0, 3);

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
      {leaders.map((item) => <div className="hot-sector-leader-card" key={`${item.type}-${item.code}`}>
        <div><b>TOP {item.rank}</b><Tag color={item.type === 'industry' ? 'blue' : 'purple'}>{item.type === 'industry' ? '行业' : '概念'}</Tag></div>
        <strong>{item.name}</strong>
        <div className="hot-sector-leader-metrics">
          <span className={(item.changePct ?? 0) >= 0 ? 'market-up' : 'market-down'}>{signed(item.changePct, '%')}</span>
          <small>主力 {signed(item.mainNetInYi, ' 亿')}</small>
        </div>
        <Progress percent={item.heatScore} showInfo={false} strokeColor={scoreColor(item.heatScore)} railColor="#e2e8f0" size="small" />
        <Text type="secondary">热度 {item.heatScore}</Text>
      </div>)}
    </div>}
    <Table<HotSectorItem>
      size="small"
      rowKey={(row) => `${row.type}-${row.code}`}
      loading={loading}
      dataSource={items}
      pagination={{ pageSize: 10, hideOnSinglePage: true, responsive: true }}
      scroll={{ x: 1050 }}
      columns={[
        { title: '排名', dataIndex: 'rank', width: 64, render: (rank: number) => <b className="hot-sector-rank">{rank}</b> },
        { title: '板块', width: 150, render: (_, row) => <div className="selection-stock-cell"><strong>{row.name}</strong><span>{row.code} · {row.type === 'industry' ? '行业' : '概念'}</span></div> },
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
    <Collapse
      className="hot-sector-collapse"
      activeKey={open ? ['hot-sectors'] : []}
      onChange={handleChange}
      items={[{
        key: 'hot-sectors',
        label: <Space><FireOutlined />当日热门板块</Space>,
        extra: open
          ? <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={(event) => { event.stopPropagation(); void load(true); }}>刷新</Button>
          : snapshot ? <Tag color="red">TOP {snapshot.items[0]?.name ?? '已有快照'}</Tag> : <Tag>展开后加载</Tag>,
        children: content,
      }]}
    />
  </section>;
}
