import { useCallback, useEffect, useMemo, useState } from 'react';
import { App, Button, Card, Checkbox, Empty, InputNumber, Select, Space, Table, Tabs, Tag, Tooltip, Typography } from 'antd';
import { FilterOutlined, PlusOutlined, PushpinFilled, PushpinOutlined, ReloadOutlined, StarFilled } from '@ant-design/icons';
import { apiFetch } from '../../api/client';
import { calculateSelectionScore } from './selectionScore';
import { klineCacheKey, marketDataCache } from './marketDataCache';
import type {
  KlinePoint,
  MarketScreenerCriteria,
  MarketScreenerSnapshot,
  MarketTechnicalCandidate,
  StockSearchItem,
  WatchlistScoreSnapshot,
} from './types';

const { Text } = Typography;
const SCORE_STORAGE_KEY = 'quant-watchlist-scores-v1';
const SCREENER_STORAGE_KEY = 'quant-market-screener-v1';

export const DEFAULT_SCREENER_CRITERIA: MarketScreenerCriteria = {
  markets: ['SH', 'SZ'],
  minChangePct: 0,
  maxChangePct: 7,
  minAmountYi: 1,
  minTurnoverPct: 0,
  minVolumeRatio: 0,
  maxAmplitudePct: 15,
  excludeRiskNames: true,
  limit: 50,
};

function readStored<T>(key: string, fallback: T): T {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? 'null') as T | null;
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

function tierColor(tier: WatchlistScoreSnapshot['tier']) {
  if (tier === 'core') return 'green';
  if (tier === 'watch') return 'blue';
  if (tier === 'weak') return 'gold';
  if (tier === 'blocked') return 'red';
  return 'default';
}

function numberText(value: number | null, suffix = '') {
  return value == null ? '—' : `${value.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}${suffix}`;
}

interface StockSelectionWorkspaceProps {
  watchlist: StockSearchItem[];
  selectedCode: string;
  pinnedCodes: string[];
  benchmarkCandles: KlinePoint[];
  onSelect: (code: string) => void;
  onTogglePin: (code: string) => void;
  onAdd: (stock: StockSearchItem) => void;
}

export default function StockSelectionWorkspace({
  watchlist,
  selectedCode,
  pinnedCodes,
  benchmarkCandles,
  onSelect,
  onTogglePin,
  onAdd,
}: StockSelectionWorkspaceProps) {
  const { message } = App.useApp();
  const [scores, setScores] = useState<Record<string, WatchlistScoreSnapshot>>(
    () => readStored(SCORE_STORAGE_KEY, {}),
  );
  const [rankingLoading, setRankingLoading] = useState(false);
  const storedScreener = useMemo(
    () => readStored<{ criteria: MarketScreenerCriteria; snapshot: MarketScreenerSnapshot | null }>(
      SCREENER_STORAGE_KEY,
      { criteria: DEFAULT_SCREENER_CRITERIA, snapshot: null },
    ),
    [],
  );
  const [criteria, setCriteria] = useState<MarketScreenerCriteria>(storedScreener.criteria);
  const [screenSnapshot, setScreenSnapshot] = useState<MarketScreenerSnapshot | null>(storedScreener.snapshot);
  const [screenLoading, setScreenLoading] = useState(false);

  useEffect(() => {
    localStorage.setItem(SCORE_STORAGE_KEY, JSON.stringify(scores));
  }, [scores]);
  useEffect(() => {
    localStorage.setItem(SCREENER_STORAGE_KEY, JSON.stringify({ criteria, snapshot: screenSnapshot }));
  }, [criteria, screenSnapshot]);

  const refreshScores = useCallback(async (stocks = watchlist) => {
    const scoreable = stocks.filter((item) => item.type === 'stock');
    if (scoreable.length === 0) return;
    setRankingLoading(true);
    try {
      for (let index = 0; index < scoreable.length; index += 4) {
        const batch = scoreable.slice(index, index + 4);
        const updates = await Promise.all(batch.map(async (stock): Promise<WatchlistScoreSnapshot> => {
          try {
            const key = klineCacheKey(stock.code, 'day');
            let candles = marketDataCache.klines[key];
            if (!candles) {
              candles = (await apiFetch<{ items: KlinePoint[] }>(
                `/api/market-data/stocks/${stock.code}/kline?period=day`,
              )).items ?? [];
              marketDataCache.klines[key] = candles;
            }
            const result = calculateSelectionScore(candles, benchmarkCandles);
            return {
              code: stock.code,
              score: result.score,
              tier: result.tier,
              tierLabel: result.tierLabel,
              asOf: result.asOf,
              status: result.status,
              updatedAt: new Date().toISOString(),
            };
          } catch {
            return {
              code: stock.code,
              score: null,
              tier: null,
              tierLabel: '加载失败',
              asOf: null,
              status: 'error',
              updatedAt: new Date().toISOString(),
            };
          }
        }));
        setScores((current) => ({
          ...current,
          ...Object.fromEntries(updates.map((item) => [item.code, item])),
        }));
      }
    } finally {
      setRankingLoading(false);
    }
  }, [benchmarkCandles, watchlist]);

  useEffect(() => {
    const missing = watchlist.filter((item) => item.type === 'stock' && !scores[item.code]);
    if (missing.length > 0 && !rankingLoading) void refreshScores(missing);
  }, [rankingLoading, refreshScores, scores, watchlist]);

  const rankingRows = useMemo(() => [...watchlist]
    .sort((a, b) => {
      const pinDelta = Number(pinnedCodes.includes(b.code)) - Number(pinnedCodes.includes(a.code));
      if (pinDelta !== 0) return pinDelta;
      return (scores[b.code]?.score ?? -1) - (scores[a.code]?.score ?? -1);
    })
    .map((stock, index) => ({ ...stock, rank: index + 1, snapshot: scores[stock.code] })),
  [pinnedCodes, scores, watchlist]);

  const runScreen = async (force = false) => {
    setScreenLoading(true);
    try {
      const next = await apiFetch<MarketScreenerSnapshot>('/api/market-data/technical-screen', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...criteria, force }),
        timeoutMs: 180000,
      });
      setScreenSnapshot(next);
      message.success(`已扫描 ${next.totalScanned} 只股票，筛出 ${next.items.length} 只`);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '市场技术筛选失败');
    } finally {
      setScreenLoading(false);
    }
  };

  const rankingTab = <div className="selection-ranking">
    <div className="selection-toolbar">
      <div>
        <Text strong>自选股评分排名</Text>
        <Text type="secondary">评分基于最近日 K；置顶优先，其余按分数降序。</Text>
      </div>
      <Button icon={<ReloadOutlined />} loading={rankingLoading} onClick={() => void refreshScores()}>刷新评分</Button>
    </div>
    <Table
      size="small"
      rowKey="code"
      loading={rankingLoading && rankingRows.length === 0}
      dataSource={rankingRows}
      pagination={false}
      scroll={{ x: 720 }}
      rowClassName={(row) => row.code === selectedCode ? 'is-selected' : ''}
      onRow={(row) => ({ onClick: () => onSelect(row.code) })}
      columns={[
        { title: '排名', dataIndex: 'rank', width: 62, render: (rank: number) => <b className="selection-rank">{rank}</b> },
        { title: '股票', width: 160, render: (_, row) => <div className="selection-stock-cell"><strong>{row.name}</strong><span>{row.code} · {row.market}</span></div> },
        { title: '评分', width: 90, render: (_, row) => <strong className="selection-score-value">{row.snapshot?.score ?? '—'}</strong> },
        { title: '分层', width: 120, render: (_, row) => <Tag color={tierColor(row.snapshot?.tier ?? null)}>{row.snapshot?.tierLabel ?? '待评分'}</Tag> },
        { title: '数据日期', width: 110, render: (_, row) => row.snapshot?.asOf ?? '—' },
        {
          title: '操作',
          width: 96,
          fixed: 'right',
          render: (_, row) => {
            const pinned = pinnedCodes.includes(row.code);
            return <Tooltip title={pinned ? '取消置顶' : '置顶'}>
              <Button
                type={pinned ? 'primary' : 'text'}
                icon={pinned ? <PushpinFilled /> : <PushpinOutlined />}
                aria-label={`${pinned ? '取消置顶' : '置顶'} ${row.name}`}
                onClick={(event) => { event.stopPropagation(); onTogglePin(row.code); }}
              />
            </Tooltip>;
          },
        },
      ]}
      locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="先搜索并加入自选股" /> }}
    />
  </div>;

  const screenerTab = <div className="selection-screener">
    <div className="selection-filter-grid">
      <label><span>市场</span><Select mode="multiple" value={criteria.markets} options={['SH', 'SZ', 'BJ'].map((value) => ({ value, label: value }))} onChange={(markets) => setCriteria((value) => ({ ...value, markets }))} /></label>
      <label><span>涨幅下限</span><InputNumber value={criteria.minChangePct} min={-30} max={30} suffix="%" onChange={(value) => setCriteria((item) => ({ ...item, minChangePct: value ?? 0 }))} /></label>
      <label><span>涨幅上限</span><InputNumber value={criteria.maxChangePct} min={-30} max={30} suffix="%" onChange={(value) => setCriteria((item) => ({ ...item, maxChangePct: value ?? 7 }))} /></label>
      <label><span>最小成交额</span><InputNumber value={criteria.minAmountYi} min={0} max={10000} suffix="亿" onChange={(value) => setCriteria((item) => ({ ...item, minAmountYi: value ?? 0 }))} /></label>
      <label><span>最小换手率</span><InputNumber value={criteria.minTurnoverPct} min={0} max={100} suffix="%" onChange={(value) => setCriteria((item) => ({ ...item, minTurnoverPct: value ?? 0 }))} /></label>
      <label><span>最小量比</span><InputNumber value={criteria.minVolumeRatio} min={0} max={20} step={0.1} onChange={(value) => setCriteria((item) => ({ ...item, minVolumeRatio: value ?? 0 }))} /></label>
      <label><span>最大振幅</span><InputNumber value={criteria.maxAmplitudePct} min={0} max={100} suffix="%" onChange={(value) => setCriteria((item) => ({ ...item, maxAmplitudePct: value ?? 0 }))} /></label>
      <label><span>结果数量</span><InputNumber value={criteria.limit} min={1} max={200} onChange={(value) => setCriteria((item) => ({ ...item, limit: value ?? 50 }))} /></label>
    </div>
    <div className="selection-toolbar selection-filter-actions">
      <Checkbox checked={criteria.excludeRiskNames} onChange={(event) => setCriteria((item) => ({ ...item, excludeRiskNames: event.target.checked }))}>排除 ST / 退市风险名称</Checkbox>
      <Space>
        <Button onClick={() => setCriteria(DEFAULT_SCREENER_CRITERIA)}>恢复默认</Button>
        <Button type="primary" icon={<FilterOutlined />} loading={screenLoading} onClick={() => void runScreen(false)}>开始筛选</Button>
      </Space>
    </div>
    {screenSnapshot && <div className="selection-snapshot-meta">
      <Text type="secondary">上次结果：{new Date(screenSnapshot.updatedAt).toLocaleString('zh-CN')} · 扫描 {screenSnapshot.totalScanned} 只 · 命中 {screenSnapshot.items.length} 只</Text>
    </div>}
    <Table<MarketTechnicalCandidate>
      size="small"
      rowKey="code"
      loading={screenLoading}
      dataSource={screenSnapshot?.items ?? []}
      pagination={{ pageSize: 10, hideOnSinglePage: true, responsive: true }}
      scroll={{ x: 980 }}
      columns={[
        { title: '股票', width: 150, fixed: 'left', render: (_, row) => <div className="selection-stock-cell"><strong>{row.name}</strong><span>{row.code} · {row.market}</span></div> },
        { title: '技术分', dataIndex: 'technicalScore', width: 80, sorter: (a, b) => a.technicalScore - b.technicalScore },
        { title: '涨跌幅', dataIndex: 'changePct', width: 92, render: (value) => <span className={(value ?? 0) > 0 ? 'market-up' : (value ?? 0) < 0 ? 'market-down' : ''}>{numberText(value, '%')}</span> },
        { title: '成交额', dataIndex: 'amountYi', width: 92, render: (value) => numberText(value, ' 亿') },
        { title: '换手率', dataIndex: 'turnoverPct', width: 86, render: (value) => numberText(value, '%') },
        { title: '量比', dataIndex: 'volumeRatio', width: 72, render: (value) => numberText(value) },
        { title: '振幅', dataIndex: 'amplitudePct', width: 78, render: (value) => numberText(value, '%') },
        { title: '信号', dataIndex: 'matchedSignals', width: 240, render: (signals: string[]) => <Space size={[0, 4]} wrap>{signals.map((signal) => <Tag key={signal}>{signal}</Tag>)}</Space> },
        {
          title: '操作',
          width: 90,
          fixed: 'right',
          render: (_, row) => {
            const exists = watchlist.some((item) => item.code === row.code);
            return <Button size="small" type={exists ? 'default' : 'primary'} disabled={exists} icon={<PlusOutlined />} onClick={() => onAdd({ code: row.code, name: row.name, market: row.market, type: 'stock' })}>{exists ? '已自选' : '自选'}</Button>;
          },
        },
      ]}
      locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="设置条件并开始筛选；上次结果会自动保留" /> }}
    />
  </div>;

  return <Card className="selection-workspace-card" variant="borderless">
    <Tabs
      items={[
        { key: 'ranking', label: <Space><StarFilled />自选评分</Space>, children: rankingTab },
        { key: 'screen', label: <Space><FilterOutlined />市场技术筛选</Space>, children: screenerTab },
      ]}
    />
  </Card>;
}
