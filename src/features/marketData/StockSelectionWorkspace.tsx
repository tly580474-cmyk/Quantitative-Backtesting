import { useCallback, useEffect, useMemo, useState } from 'react';
import { App, Button, Checkbox, Collapse, Empty, InputNumber, Segmented, Select, Space, Table, Tag, Tooltip, Typography } from 'antd';
import { FilterOutlined, MinusOutlined, PlusOutlined, PushpinFilled, PushpinOutlined, ReloadOutlined, StarFilled } from '@ant-design/icons';
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
  trend: 'any',
  returnPeriod: 20,
  minPeriodReturn: -30,
  maxPeriodReturn: 30,
  streakDirection: 'any',
  minStreakDays: 2,
  minRsi: 0,
  maxRsi: 100,
  kdjSignal: 'any',
  macdSignal: 'any',
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

function trendTag(value: MarketTechnicalCandidate['indicators']) {
  if (!value) return <Tag>数据不足</Tag>;
  if (value.trend === 'bullish') return <Tag color="green">均线多头</Tag>;
  if (value.trend === 'aboveMa20') return <Tag color="blue">站上 MA20</Tag>;
  if (value.trend === 'bearish') return <Tag color="red">均线空头</Tag>;
  return <Tag color="gold">均线交错</Tag>;
}

function crossTag(value: 'golden' | 'death' | 'none' | undefined) {
  if (value === 'golden') return <Tag color="green">金叉</Tag>;
  if (value === 'death') return <Tag color="red">死叉</Tag>;
  return <Tag>无交叉</Tag>;
}

interface StockSelectionWorkspaceProps {
  mode?: 'all' | 'ranking' | 'screen';
  watchlist: StockSearchItem[];
  selectedCode: string;
  pinnedCodes: string[];
  benchmarkCandles: KlinePoint[];
  onSelect: (code: string) => void;
  onTogglePin: (code: string) => void;
  onAdd: (stock: StockSearchItem) => void;
  onRemove: (code: string) => void;
  onOpenDetail?: (stock: StockSearchItem) => void;
}

export default function StockSelectionWorkspace({
  mode = 'all',
  watchlist,
  selectedCode,
  pinnedCodes,
  benchmarkCandles,
  onSelect,
  onTogglePin,
  onAdd,
  onRemove,
  onOpenDetail,
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
  const [criteria, setCriteria] = useState<MarketScreenerCriteria>({
    ...DEFAULT_SCREENER_CRITERIA,
    ...storedScreener.criteria,
  });
  const [dataMode, setDataMode] = useState<'realtime' | 'close'>('realtime');
  const [screenSnapshot, setScreenSnapshot] = useState<MarketScreenerSnapshot | null>(storedScreener.snapshot);
  const [screenLoading, setScreenLoading] = useState(false);
  const [activeSections, setActiveSections] = useState<string[]>(mode === 'ranking' ? ['ranking'] : []);

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
    if (!activeSections.includes('ranking')) return;
    const missing = watchlist.filter((item) => item.type === 'stock' && !scores[item.code]);
    if (missing.length > 0 && !rankingLoading) void refreshScores(missing);
  }, [activeSections, rankingLoading, refreshScores, scores, watchlist]);

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
        body: JSON.stringify({ ...criteria, mode: dataMode, force }),
        timeoutMs: 180000,
      });
      setScreenSnapshot(next);
      message.success(`已扫描 ${next.totalScanned} 只，完成 ${next.totalEnriched} 只日 K 分析，筛出 ${next.items.length} 只`);
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
    <div className="selection-toolbar" style={{ marginBottom: 12 }}>
      <Space>
        <Text strong>数据源</Text>
        <Segmented
          value={dataMode}
          onChange={(value) => setDataMode(value as 'realtime' | 'close')}
          options={[
            { label: '实时', value: 'realtime' },
            { label: '盘后 (T-1)', value: 'close' },
          ]}
        />
        <Text type="secondary">{dataMode === 'close' ? '盘后取本地 MySQL 快照，稳定快速' : '盘中实时行情，依赖外部接口'}</Text>
      </Space>
    </div>

    <div className="selection-filter-group">
      <Text strong>实时量价初筛</Text>
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
    </div>
    <div className="selection-filter-group">
      <div className="selection-filter-group-head">
        <Text strong>日 K 技术条件</Text>
        <Text type="secondary">实时量价初筛后，并发分析最多 160 只候选股的 120 日日 K。</Text>
      </div>
      <div className="selection-filter-grid">
        <label><span>均线趋势</span><Select value={criteria.trend} options={[{ value: 'any', label: '不限' }, { value: 'bullish', label: 'MA5>10>20>60 多头' }, { value: 'aboveMa20', label: '股价站上 MA20' }, { value: 'bearish', label: 'MA5<10<20<60 空头' }]} onChange={(trend) => setCriteria((item) => ({ ...item, trend }))} /></label>
        <label><span>阶段周期</span><Select value={criteria.returnPeriod} options={[5, 10, 20].map((value) => ({ value, label: `${value} 日涨跌幅` }))} onChange={(returnPeriod) => setCriteria((item) => ({ ...item, returnPeriod }))} /></label>
        <label><span>阶段涨幅下限</span><InputNumber value={criteria.minPeriodReturn} min={-100} max={1000} suffix="%" onChange={(value) => setCriteria((item) => ({ ...item, minPeriodReturn: value ?? -30 }))} /></label>
        <label><span>阶段涨幅上限</span><InputNumber value={criteria.maxPeriodReturn} min={-100} max={1000} suffix="%" onChange={(value) => setCriteria((item) => ({ ...item, maxPeriodReturn: value ?? 30 }))} /></label>
        <label><span>连续涨跌</span><Select value={criteria.streakDirection} options={[{ value: 'any', label: '不限' }, { value: 'up', label: '连续上涨' }, { value: 'down', label: '连续下跌' }]} onChange={(streakDirection) => setCriteria((item) => ({ ...item, streakDirection }))} /></label>
        <label><span>最少连续天数</span><InputNumber value={criteria.minStreakDays} min={1} max={20} suffix="天" onChange={(value) => setCriteria((item) => ({ ...item, minStreakDays: value ?? 2 }))} /></label>
        <label><span>RSI14 下限</span><InputNumber value={criteria.minRsi} min={0} max={100} onChange={(value) => setCriteria((item) => ({ ...item, minRsi: value ?? 0 }))} /></label>
        <label><span>RSI14 上限</span><InputNumber value={criteria.maxRsi} min={0} max={100} onChange={(value) => setCriteria((item) => ({ ...item, maxRsi: value ?? 100 }))} /></label>
        <label><span>KDJ 信号</span><Select value={criteria.kdjSignal} options={[{ value: 'any', label: '不限' }, { value: 'golden', label: '当日金叉' }, { value: 'death', label: '当日死叉' }]} onChange={(kdjSignal) => setCriteria((item) => ({ ...item, kdjSignal }))} /></label>
        <label><span>MACD 信号</span><Select value={criteria.macdSignal} options={[{ value: 'any', label: '不限' }, { value: 'golden', label: '当日金叉' }, { value: 'death', label: '当日死叉' }]} onChange={(macdSignal) => setCriteria((item) => ({ ...item, macdSignal }))} /></label>
      </div>
    </div>
    <div className="selection-toolbar selection-filter-actions">
      <Checkbox checked={criteria.excludeRiskNames} onChange={(event) => setCriteria((item) => ({ ...item, excludeRiskNames: event.target.checked }))}>排除 ST / 退市风险名称</Checkbox>
      <Space>
        <Button onClick={() => setCriteria(DEFAULT_SCREENER_CRITERIA)}>恢复默认</Button>
        <Button type="primary" icon={<FilterOutlined />} loading={screenLoading} onClick={() => void runScreen(false)}>{screenLoading ? '读取快照并分析日 K' : '开始筛选'}</Button>
      </Space>
    </div>
    {screenSnapshot && <div className="selection-snapshot-meta">
      <Text type="secondary">上次结果：{new Date(screenSnapshot.updatedAt).toLocaleString('zh-CN')} · 扫描 {screenSnapshot.totalScanned} 只 · 日 K 分析 {screenSnapshot.totalEnriched ?? 0} 只 · 命中 {screenSnapshot.items.length} 只</Text>
    </div>}
    <Table<MarketTechnicalCandidate>
      size="small"
      rowKey="code"
      loading={screenLoading}
      dataSource={screenSnapshot?.items ?? []}
      pagination={{ pageSize: 10, hideOnSinglePage: true, responsive: true }}
      scroll={{ x: 1520 }}
      columns={[
        { title: '股票', width: 150, fixed: 'left', render: (_, row) => (
          <div className="selection-stock-cell clickable" onClick={() => onOpenDetail?.({ code: row.code, name: row.name, market: row.market, type: 'stock' as const })}>
            <strong>{row.name}</strong>
            <span>{row.code} · {row.market}</span>
          </div>
        ) },
        { title: '技术分', dataIndex: 'technicalScore', width: 80, sorter: (a, b) => a.technicalScore - b.technicalScore },
        { title: '涨跌幅', dataIndex: 'changePct', width: 92, render: (value) => <span className={(value ?? 0) > 0 ? 'market-up' : (value ?? 0) < 0 ? 'market-down' : ''}>{numberText(value, '%')}</span> },
        { title: '均线趋势', width: 118, render: (_, row) => <Tooltip title={row.indicators ? `MA5 ${row.indicators.ma5} / MA10 ${row.indicators.ma10} / MA20 ${row.indicators.ma20} / MA60 ${row.indicators.ma60}` : '有效日 K 少于 65 根或加载失败'}>{trendTag(row.indicators)}</Tooltip> },
        { title: '5/10/20日', width: 150, render: (_, row) => row.indicators ? <span className="selection-return-cell">{numberText(row.indicators.return5d, '%')} / {numberText(row.indicators.return10d, '%')} / {numberText(row.indicators.return20d, '%')}</span> : '—' },
        { title: '连续涨跌', width: 90, render: (_, row) => row.indicators?.streak ? <Tag color={row.indicators.streak > 0 ? 'red' : 'green'}>{row.indicators.streak > 0 ? `连涨 ${row.indicators.streak} 天` : `连跌 ${Math.abs(row.indicators.streak)} 天`}</Tag> : '—' },
        { title: 'RSI14', width: 72, render: (_, row) => numberText(row.indicators?.rsi14 ?? null) },
        { title: 'KDJ', width: 90, render: (_, row) => <Tooltip title={row.indicators ? `K ${row.indicators.kdjK} / D ${row.indicators.kdjD} / J ${row.indicators.kdjJ}` : '暂无数据'}>{crossTag(row.indicators?.kdjSignal)}</Tooltip> },
        { title: 'MACD', width: 90, render: (_, row) => <Tooltip title={row.indicators ? `DIF ${row.indicators.macdDif} / DEA ${row.indicators.macdDea} / 柱 ${row.indicators.macdHistogram}` : '暂无数据'}>{crossTag(row.indicators?.macdSignal)}</Tooltip> },
        { title: '成交额', dataIndex: 'amountYi', width: 92, render: (value) => numberText(value, ' 亿') },
        { title: '信号', dataIndex: 'matchedSignals', width: 240, render: (signals: string[]) => <Space size={[0, 4]} wrap>{signals.map((signal) => <Tag key={signal}>{signal}</Tag>)}</Space> },
        {
          title: '操作',
          width: 90,
          fixed: 'right',
          render: (_, row) => {
            const exists = watchlist.some((item) => item.code === row.code);
            return exists
              ? <Button size="small" danger icon={<MinusOutlined />} onClick={() => onRemove(row.code)}>取消自选</Button>
              : <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => onAdd({ code: row.code, name: row.name, market: row.market, type: 'stock' })}>加自选</Button>;
          },
        },
      ]}
      locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="设置条件并开始筛选；上次结果会自动保留" /> }}
    />
  </div>;

  return <Collapse
    className="selection-workspace-collapse"
    activeKey={activeSections}
    onChange={(keys) => setActiveSections((Array.isArray(keys) ? keys : [keys]).map(String))}
    items={[
      {
        key: 'ranking',
        label: <Space><StarFilled />自选评分<Tag>{watchlist.length}</Tag></Space>,
        children: rankingTab,
      },
      {
        key: 'screen',
        label: <Space><FilterOutlined />市场技术筛选{screenSnapshot && <Tag color="blue">{screenSnapshot.items.length}</Tag>}</Space>,
        children: screenerTab,
      },
    ].filter((item) => mode === 'all' || item.key === mode)}
  />;
}
