import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { App, AutoComplete, Button, Card, Checkbox, Collapse, Drawer, Empty, Input, Modal, Segmented, Select, Skeleton, Space, Spin, Table, Tag, Tooltip, Typography } from 'antd';
import { ArrowDownOutlined, ArrowRightOutlined, ArrowUpOutlined, BarChartOutlined, CheckCircleOutlined, CheckOutlined, CopyOutlined, DashboardOutlined, DatabaseOutlined, DeleteOutlined, DownloadOutlined, ExportOutlined, FileSearchOutlined, FireOutlined, LineChartOutlined, PlusOutlined, ReloadOutlined, RobotOutlined, SearchOutlined, SettingOutlined, StarFilled, StarOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { ColorType, createChart, LineSeries, type Time } from 'lightweight-charts';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { apiFetch } from '../../api/client';
import MarketKlineChart from './MarketKlineChart';
import StockSelectionScore from './StockSelectionScore';
import StockSelectionWorkspace from './StockSelectionWorkspace';
import HotSectorPanel from './HotSectorPanel';
import { klineCacheKey, marketDataCache } from './marketDataCache';
import { exportMarketKlinesToExcel, toCandles } from './exportMarketData';
import type { AgentStatus, KlinePoint, MarketBreadthBucket, MarketBreadthStock, MarketKlinePeriod, MarketSentimentOverview, ResearchReport, SevenLayerRecord, SevenLayerSection, StockQuote, StockSearchItem } from './types';
import type { ImportResult } from '@/models';

const { Text, Title } = Typography;
const WATCHLIST_KEY = 'quant-market-watchlist-v1';
const PINNED_WATCHLIST_KEY = 'quant-market-watchlist-pinned-v1';
const MARKET_INDEX_SELECTION_KEY = 'quant-market-index-selection-v1';
const MARKET_SENTIMENT_REFRESH_MS = 5 * 60_000;
const MARKET_INDEX_OPTIONS: Array<{ key: string; code: string; name: string; market: StockSearchItem['market'] }> = [
  { key: 'SH:000001', code: '000001', name: '上证指数', market: 'SH' },
  { key: 'SZ:399001', code: '399001', name: '深证成指', market: 'SZ' },
  { key: 'SZ:399006', code: '399006', name: '创业板指', market: 'SZ' },
  { key: 'SH:000688', code: '000688', name: '科创50', market: 'SH' },
  { key: 'SH:000300', code: '000300', name: '沪深300', market: 'SH' },
  { key: 'SH:000905', code: '000905', name: '中证500', market: 'SH' },
  { key: 'SH:000852', code: '000852', name: '中证1000', market: 'SH' },
];
const DEFAULT_MARKET_INDEX_KEYS = MARKET_INDEX_OPTIONS.slice(0, 5).map((item) => item.key);
const DEFAULT_WATCHLIST: StockSearchItem[] = [
  { code: '600519', name: '贵州茅台', market: 'SH', type: 'stock' },
  { code: '000001', name: '平安银行', market: 'SZ', type: 'stock' },
];
const SEVEN_LAYER_DEFS: Array<{ key: SevenLayerSection['key']; title: string; summary: string }> = [
  { key: 'signal', title: '信号', summary: '同花顺热点/北向/龙虎榜/解禁/行业线索' },
  { key: 'capital', title: '资金面', summary: '融资融券/大宗交易/股东户数/分钟资金流/120日资金流' },
  { key: 'fundamental', title: '基础数据', summary: '公司画像/估值股本/核心财务/财报摘要' },
  { key: 'announcement', title: '公告', summary: '巨潮公告检索' },
];
const METRIC_LABELS: Record<string, { label: string; unit?: 'percent' | 'yuan' | 'shares' | 'text' | 'date' | 'number' }> = {
  f3: { label: '板块涨跌幅', unit: 'percent' },
  f62: { label: '主力净流入', unit: 'yuan' },
  f184: { label: '主力净占比', unit: 'percent' },
  f66: { label: '超大单净流入', unit: 'yuan' },
  f69: { label: '超大单净占比', unit: 'percent' },
  TRADE_DATE: { label: '上榜交易日' },
  DATE: { label: '日期' },
  SECURITY_NAME_ABBR: { label: '证券简称' },
  SECNAME: { label: '证券简称' },
  EXPLANATION: { label: '上榜原因' },
  BILLBOARD_DEAL_AMT: { label: '当日成交额', unit: 'yuan' },
  RZYE: { label: '融资余额', unit: 'yuan' },
  RQYL: { label: '融券余量' },
  RZRQYE: { label: '融资融券余额', unit: 'yuan' },
  END_DATE: { label: '截止日期' },
  HOLDER_NUM: { label: '股东户数' },
  HOLDER_NUM_RATIO: { label: '户数变化率', unit: 'percent' },
  AVG_MARKET_CAP: { label: '户均持股市值' },
  date: { label: '日期' },
  mainNetIn: { label: '主力净流入', unit: 'yuan' },
  smallNetIn: { label: '小单净流入', unit: 'yuan' },
  midNetIn: { label: '中单净流入', unit: 'yuan' },
  largeNetIn: { label: '大单净流入', unit: 'yuan' },
  superNetIn: { label: '超大单净流入', unit: 'yuan' },
  stockCode: { label: '证券代码', unit: 'text' },
  stockName: { label: '证券简称', unit: 'text' },
  industry: { label: '所属行业', unit: 'text' },
  region: { label: '所属地区', unit: 'text' },
  concepts: { label: '题材概念', unit: 'text' },
  listDate: { label: '上市日期', unit: 'date' },
  totalShares: { label: '总股本', unit: 'shares' },
  floatShares: { label: '流通股本', unit: 'shares' },
  totalMarketCap: { label: '总市值', unit: 'yuan' },
  floatMarketCap: { label: '流通市值', unit: 'yuan' },
  peTtm: { label: 'PE(TTM)', unit: 'number' },
  pb: { label: 'PB', unit: 'number' },
  ps: { label: 'PS', unit: 'number' },
  peg: { label: 'PEG', unit: 'number' },
  dividendYield: { label: '股息率', unit: 'percent' },
  reportPeriod: { label: '报告期', unit: 'text' },
  revenue: { label: '营业收入', unit: 'yuan' },
  grossProfit: { label: '毛利', unit: 'yuan' },
  netProfit: { label: '归母净利润', unit: 'yuan' },
  deductNetProfit: { label: '扣非净利润', unit: 'yuan' },
  revenueGrowth: { label: '营收同比', unit: 'percent' },
  netProfitGrowth: { label: '净利同比', unit: 'percent' },
  roe: { label: 'ROE', unit: 'percent' },
  grossMargin: { label: '毛利率', unit: 'percent' },
  netMargin: { label: '净利率', unit: 'percent' },
  debtRatio: { label: '资产负债率', unit: 'percent' },
  eps: { label: '每股收益', unit: 'number' },
  bps: { label: '每股净资产', unit: 'number' },
  operatingCashPerShare: { label: '每股经营现金流', unit: 'number' },
  secCode: { label: '证券代码', unit: 'text' },
  secName: { label: '证券简称', unit: 'text' },
  announcementTypeName: { label: '公告类型', unit: 'text' },
  adjunctType: { label: '附件类型', unit: 'text' },
  announcementId: { label: '公告编号', unit: 'text' },
};
const TREND_CHART_DEFS: Record<string, Array<{ key: string; label: string; color: string }>> = {
  东财120日资金流: [
    { key: 'mainNetIn', label: '主力净流入', color: '#2563eb' },
    { key: 'smallNetIn', label: '小单净流入', color: '#64748b' },
    { key: 'midNetIn', label: '中单净流入', color: '#f59e0b' },
    { key: 'largeNetIn', label: '大单净流入', color: '#16a34a' },
    { key: 'superNetIn', label: '超大单净流入', color: '#dc2626' },
  ],
  东财融资融券: [
    { key: 'RZYE', label: '融资余额', color: '#2563eb' },
    { key: 'RZRQYE', label: '融资融券余额', color: '#dc2626' },
  ],
  东财股东户数: [
    { key: 'HOLDER_NUM', label: '股东户数', color: '#2563eb' },
  ],
};

function readWatchlist(): StockSearchItem[] {
  try {
    const stored = JSON.parse(localStorage.getItem(WATCHLIST_KEY) ?? '[]') as StockSearchItem[];
    return Array.isArray(stored) && stored.length ? stored : DEFAULT_WATCHLIST;
  } catch { return DEFAULT_WATCHLIST; }
}
function readPinnedCodes(): string[] {
  try {
    const stored = JSON.parse(localStorage.getItem(PINNED_WATCHLIST_KEY) ?? '[]') as string[];
    return Array.isArray(stored) ? stored.filter((item) => typeof item === 'string') : [];
  } catch { return []; }
}
function readMarketIndexSelection(): string[] {
  try {
    const stored = JSON.parse(localStorage.getItem(MARKET_INDEX_SELECTION_KEY) ?? '[]') as string[];
    const valid = MARKET_INDEX_OPTIONS.map((item) => item.key);
    const selected = Array.isArray(stored) ? stored.filter((key) => valid.includes(key)).slice(0, 5) : [];
    return selected.length ? selected : DEFAULT_MARKET_INDEX_KEYS;
  } catch { return DEFAULT_MARKET_INDEX_KEYS; }
}
function marketIndexKey(item: Pick<StockQuote, 'market' | 'code'>) {
  return `${item.market}:${item.code}`;
}
function marketIndexInstrumentCode(item: Pick<StockSearchItem, 'market' | 'code'>) {
  return `${item.market.toLowerCase()}${item.code}`;
}
function fmt(value: number | null | undefined, digits = 2) {
  return value == null ? '—' : value.toLocaleString('zh-CN', { maximumFractionDigits: digits });
}
function amount(value: number | null) {
  if (value == null) return '—';
  return value >= 10000 ? `${fmt(value / 10000)} 亿` : `${fmt(value)} 万`;
}
function formatMetricValue(key: string, value: unknown) {
  const meta = METRIC_LABELS[key];
  if (meta?.unit === 'text') return String(value ?? '—').slice(0, 80);
  if (meta?.unit === 'date') return String(value ?? '—').slice(0, 10);
  const num = typeof value === 'number' ? value : Number(value);
  if (!meta || !Number.isFinite(num)) return String(value).slice(0, 36);
  if (meta.unit === 'percent') return `${fmt(num)}%`;
  if (meta.unit === 'yuan') return `${(num / 100000000).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} 亿`;
  if (meta.unit === 'shares') return `${(num / 100000000).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} 亿股`;
  if (meta.unit === 'number') return fmt(num, 4);
  return fmt(num);
}
function Metric({ label, value }: { label: string; value: string }) {
  return <div className="market-metric"><Text type="secondary">{label}</Text><Text strong>{value}</Text></div>;
}

function IndexSparkline({ points, label, tone }: { points: KlinePoint[] | undefined; label: string; tone: 'up' | 'down' | 'flat' }) {
  if (points === undefined) return <div className="market-index-preview is-loading" aria-label={`${label}走势预览加载中`}><span /></div>;
  const values = points.slice(-30).map((point) => point.close).filter(Number.isFinite);
  if (values.length < 2) return <div className="market-index-preview is-empty" aria-label={`${label}暂无走势数据`}><span>暂无走势</span></div>;
  const width = 240;
  const height = 46;
  const padding = 3;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(max - min, Math.abs(max) * 0.001, 1);
  const coordinates = values.map((value, index) => ({
    x: padding + (index / (values.length - 1)) * (width - padding * 2),
    y: padding + ((max - value) / range) * (height - padding * 2),
  }));
  const line = coordinates.map(({ x, y }) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `M ${coordinates[0].x.toFixed(1)} ${height} L ${coordinates.map(({ x, y }) => `${x.toFixed(1)} ${y.toFixed(1)}`).join(' L ')} L ${coordinates[coordinates.length - 1].x.toFixed(1)} ${height} Z`;
  return <svg className={`market-index-preview is-${tone}`} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={`${label}近30个交易日走势预览`}>
    <title>{label}近30个交易日走势预览</title>
    <line x1="0" y1={height / 2} x2={width} y2={height / 2} className="market-index-preview-baseline" />
    <path d={area} className="market-index-preview-area" />
    <polyline points={line} className="market-index-preview-line" />
  </svg>;
}

function sourceTag(source: MarketSentimentOverview['factors'][number]['source']) {
  if (source === 'live') return <Tag color="green">实时</Tag>;
  if (source === 'estimated') return <Tag color="gold">估算</Tag>;
  return <Tag>待接入</Tag>;
}

function sentimentRangeLabel(msi: number) {
  if (msi > 60) return '情绪过热，见顶风险高';
  if (msi > 30) return '赚钱效应强，多头占优';
  if (msi >= -30) return '情绪平稳，震荡观察';
  if (msi >= -60) return '普跌亏钱，空头占优';
  return '极致恐慌，关注超跌修复';
}

function signed(value: number | null | undefined, digits = 2) {
  if (value == null) return '—';
  return value > 0 ? `+${fmt(value, digits)}` : fmt(value, digits);
}

function SentimentMetricStrip({ overview }: { overview: MarketSentimentOverview }) {
  const metrics = [
    { key: 'msi', label: 'MSI', value: signed(overview.msi), icon: <LineChartOutlined />, tone: overview.msi >= 0 ? 'up' : 'down' },
    { key: 'advancers', label: '上涨家数', value: `${fmt(overview.advancers, 0)} 家`, icon: <ArrowUpOutlined />, tone: 'up' },
    { key: 'decliners', label: '下跌家数', value: `${fmt(overview.decliners, 0)} 家`, icon: <ArrowDownOutlined />, tone: 'down' },
    { key: 'upLimit', label: '涨停家数', value: `${fmt(overview.upLimit, 0)} 家`, icon: <FireOutlined />, tone: 'up' },
    { key: 'downLimit', label: '跌停家数', value: `${fmt(overview.downLimit, 0)} 家`, icon: <ThunderboltOutlined />, tone: 'down' },
  ];
  return <div className="market-sentiment-metric-strip">
    {metrics.map((item) => <div key={item.key} className={`market-sentiment-kpi is-${item.tone}`}>
      <i>{item.icon}</i>
      <span>{item.label}</span>
      <strong>{item.value}</strong>
    </div>)}
  </div>;
}

function MarketBreadthChart({
  overview,
  onSelectStock,
}: {
  overview: MarketSentimentOverview;
  onSelectStock: (stock: StockSearchItem) => void;
}) {
  const [selectedBucket, setSelectedBucket] = useState<MarketBreadthBucket | null>(null);
  const [stockQuery, setStockQuery] = useState('');
  const maxCount = Math.max(1, ...overview.distribution.map((item) => item.count));
  const advanceRatio = (overview.advancers / Math.max(1, overview.advancers + overview.decliners)) * 100;
  const filteredStocks = useMemo(() => {
    const query = stockQuery.trim().toLowerCase();
    const source = selectedBucket?.items ?? [];
    return query
      ? source.filter((stock) => stock.code.includes(query) || stock.name.toLowerCase().includes(query))
      : source;
  }, [selectedBucket, stockQuery]);
  const openBucket = (bucket: MarketBreadthBucket) => {
    setSelectedBucket(bucket);
    setStockQuery('');
  };
  const selectStock = (stock: MarketBreadthStock) => {
    onSelectStock({ code: stock.code, name: stock.name, market: stock.market, type: 'stock' });
    setSelectedBucket(null);
  };

  return <>
    <div className="market-breadth-chart" aria-label="涨跌分布图">
      <div className="market-panel-title">
        <span><BarChartOutlined />涨跌分布</span>
        <Tooltip title="有效A股报价按代码去重并排除ST/退市；涨跌停优先按当日涨停价/跌停价判断。点击柱形查看股票明细。"><Text type="secondary">?</Text></Tooltip>
      </div>
      <div className="market-breadth-body">
        <div className="market-breadth-summary">
          <div className="is-up"><strong>{overview.advancers}</strong><span>上涨家数</span><b>↑</b></div>
          <div className="is-down"><strong>{overview.decliners}</strong><span>下跌家数</span><b>↓</b></div>
        </div>
        <div className="market-breadth-bars">
          {overview.distribution.map((item) => {
            const height = 8 + (item.count / maxCount) * 108;
            return <button
              type="button"
              key={item.key}
              className={`market-breadth-bar is-${item.tone}`}
              onClick={() => openBucket(item)}
              aria-label={`查看${item.label}的${item.count}只股票`}
            >
              <b>{item.count}</b>
              <i style={{ height }} />
              <span>{item.label}</span>
            </button>;
          })}
        </div>
      </div>
      <div className="market-breadth-scale">
        <div>
          <span><i />涨 {overview.advancers} 家</span>
          <em style={{ background: `linear-gradient(90deg, #ef4444 0%, #ef4444 ${advanceRatio}%, #16a34a ${advanceRatio}%, #16a34a 100%)` }} />
          <strong>跌 {overview.decliners} 家</strong>
        </div>
      </div>
    </div>
    <Drawer
      className="market-breadth-drawer"
      title={<Space><span>{selectedBucket?.label ?? '涨跌区间'}股票明细</span>{selectedBucket && <Tag color={selectedBucket.tone === 'up' ? 'red' : selectedBucket.tone === 'down' ? 'green' : 'default'}>{selectedBucket.count} 只</Tag>}</Space>}
      open={selectedBucket != null}
      onClose={() => setSelectedBucket(null)}
      size="min(900px, 92vw)"
      destroyOnHidden
    >
      <div className="market-breadth-detail-toolbar">
        <Text type="secondary">快照时间：{new Date(overview.updatedAt).toLocaleString('zh-CN')} · 点击股票查看行情详情</Text>
        <Input
          allowClear
          prefix={<SearchOutlined />}
          placeholder="搜索股票名称或代码"
          aria-label="搜索涨跌区间股票"
          value={stockQuery}
          onChange={(event) => setStockQuery(event.target.value)}
        />
      </div>
      <Table<MarketBreadthStock>
        className="market-breadth-detail-table"
        size="small"
        rowKey="code"
        dataSource={filteredStocks}
        pagination={{ pageSize: 15, showSizeChanger: false, showTotal: (total) => `共 ${total} 只` }}
        scroll={{ x: 760 }}
        onRow={(row) => ({
          className: 'market-breadth-stock-row',
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
          { title: '股票', fixed: 'left', width: 140, render: (_, row) => <div className="selection-stock-cell"><strong>{row.name}</strong><span>{row.code} · {row.market}</span></div> },
          { title: '最新价', dataIndex: 'price', width: 90, align: 'right', render: (value) => fmt(value) },
          { title: '涨跌幅', dataIndex: 'changePct', width: 96, align: 'right', sorter: (a, b) => a.changePct - b.changePct, render: (value) => <span className={value > 0 ? 'market-up' : value < 0 ? 'market-down' : ''}>{signed(value)}%</span> },
          { title: '成交额', dataIndex: 'amountYi', width: 100, align: 'right', sorter: (a, b) => (a.amountYi ?? 0) - (b.amountYi ?? 0), render: (value) => value == null ? '—' : `${fmt(value)} 亿` },
          { title: '换手率', dataIndex: 'turnoverPct', width: 90, align: 'right', render: (value) => value == null ? '—' : `${fmt(value)}%` },
          { title: '振幅', dataIndex: 'amplitudePct', width: 86, align: 'right', render: (value) => value == null ? '—' : `${fmt(value)}%` },
          { title: '量比', dataIndex: 'volumeRatio', width: 78, align: 'right', render: (value) => fmt(value) },
        ]}
        locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={stockQuery ? '没有匹配的股票' : '该区间暂无股票明细，请刷新市场概况'} /> }}
      />
    </Drawer>
  </>;
}

function MarketThermometer({ overview }: { overview: MarketSentimentOverview }) {
  const position = ((overview.msi + 100) / 200) * 100;
  return <div className={`market-thermometer is-${overview.status}`}>
    <div className="market-thermometer-head">
      <div>
        <Text type="secondary"><DashboardOutlined /> 大盘情绪温度计</Text>
        <strong>{overview.statusLabel}</strong>
      </div>
      <b>{signed(overview.msi)}</b>
    </div>
    <div className="market-thermometer-track">
      <span style={{ left: `${position}%` }} />
    </div>
    <div className="market-thermometer-axis"><span>-100</span><span>-60</span><span>-30</span><span>30</span><span>60</span><span>100</span></div>
    <Text type="secondary">{sentimentRangeLabel(overview.msi)}</Text>
    <div className={`market-structure-callout is-${overview.structure}`}>
      <strong>{overview.structureLabel}</strong>
      <span>{overview.structureDescription}</span>
      <small>广度－权重指数：{signed(overview.breadthIndexDivergence)}</small>
    </div>
    <div className="market-factor-list">
      {overview.factors.map((factor) => <Tooltip key={factor.key} title={`${factor.formula}。${factor.description}`}>
        <div className="market-factor-row">
          <span><b>{factor.key}</b>{factor.label}<small>{Math.round(factor.weight * 100)}%</small></span>
          {sourceTag(factor.source)}
          <strong className={factor.value > 0 ? 'market-up' : factor.value < 0 ? 'market-down' : ''}>{fmt(factor.value)}</strong>
        </div>
      </Tooltip>)}
    </div>
  </div>;
}

function MarketSentimentPanel({ overview, loading, onSelectStock }: { overview: MarketSentimentOverview | null; loading: boolean; onSelectStock: (stock: StockSearchItem) => void }) {
  return <div className="market-sentiment-panel">
    <Skeleton loading={loading && !overview} active paragraph={{ rows: 6 }}>
      {overview ? <div className="market-sentiment-layout">
        <div className="market-sentiment-main">
          <SentimentMetricStrip overview={overview} />
          <MarketBreadthChart overview={overview} onSelectStock={onSelectStock} />
        </div>
        <MarketThermometer overview={overview} />
        <div className="market-sentiment-notes">
          {overview.notes.map((note) => <Text key={note} type="secondary">{note}</Text>)}
        </div>
      </div> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无市场情绪数据" />}
    </Skeleton>
  </div>;
}

function statusColor(status: SevenLayerSection['status']) {
  return status === 'ok' ? 'green' : status === 'partial' ? 'gold' : 'red';
}

function metricPreview(metrics: Record<string, unknown> | undefined) {
  if (!metrics) return [];
  return Object.entries(metrics)
    .filter(([, value]) => value != null && value !== '')
    .slice(0, 5)
    .map(([key, value]) => `${METRIC_LABELS[key]?.label ?? key}: ${formatMetricValue(key, value)}`);
}

function formatRecordSummary(record: SevenLayerRecord) {
  return record.metrics ? undefined : record.summary;
}

function SevenLayerRecordItem({ record }: { record: SevenLayerRecord }) {
  const metrics = metricPreview(record.metrics);
  const summary = formatRecordSummary(record);
  return <div className="market-seven-record">
    <div className="market-seven-record-head">
      <Tag>{record.source}</Tag>
      {record.date && <Text type="secondary">{record.date}</Text>}
      {record.url ? <a href={record.url} target="_blank" rel="noreferrer">{record.title}</a> : <Text strong>{record.title}</Text>}
    </div>
    {summary && <Text type="secondary" className="market-seven-summary">{summary}</Text>}
    {metrics.length > 0 && <div className="market-seven-metrics">{metrics.map((item) => <Tag key={item}>{item}</Tag>)}</div>}
  </div>;
}

function metricNumber(metrics: Record<string, unknown> | undefined, key: string) {
  const value = metrics?.[key];
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function chartMetricValue(metrics: Record<string, unknown> | undefined, key: string) {
  const value = metricNumber(metrics, key);
  if (value == null) return null;
  return METRIC_LABELS[key]?.unit === 'yuan' ? value / 100000000 : value;
}

function metricDate(record: SevenLayerRecord) {
  return String(record.metrics?.date ?? record.metrics?.DATE ?? record.metrics?.END_DATE ?? record.date ?? '').slice(0, 10);
}

function FlowStackedBarChart({ records }: { records: SevenLayerRecord[] }) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const seriesDefs = TREND_CHART_DEFS.东财120日资金流;
  const points = records
    .map((record) => ({ date: metricDate(record), metrics: record.metrics }))
    .filter((item) => /^\d{4}-\d{2}-\d{2}$/.test(item.date))
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-120);
  if (points.length === 0) return null;

  const stacks = points.map((point) => {
    const values = seriesDefs.map((definition) => ({
      ...definition,
      value: metricNumber(point.metrics, definition.key) ?? 0,
    }));
    return {
      ...point,
      values,
      positive: values.filter((item) => item.value > 0).reduce((sum, item) => sum + item.value, 0),
      negative: Math.abs(values.filter((item) => item.value < 0).reduce((sum, item) => sum + item.value, 0)),
    };
  });
  const maxPositive = Math.max(1, ...stacks.map((item) => item.positive));
  const maxNegative = Math.max(1, ...stacks.map((item) => item.negative));
  const width = Math.max(720, points.length * 9);
  const height = 300;
  const top = 22;
  const bottom = 34;
  const plotHeight = height - top - bottom;
  const zeroY = top + (maxPositive / (maxPositive + maxNegative)) * plotHeight;
  const positiveScale = (zeroY - top) / maxPositive;
  const negativeScale = (top + plotHeight - zeroY) / maxNegative;
  const slot = width / Math.max(points.length, 1);
  const barWidth = Math.max(4, Math.min(28, slot * 0.62));
  const hoveredStack = hoveredIndex == null ? null : stacks[hoveredIndex];
  const latest = [...records]
    .filter((record) => metricDate(record))
    .sort((a, b) => metricDate(b).localeCompare(metricDate(a)))[0];
  const latestMetrics = metricPreview(latest?.metrics);

  return <div className="market-seven-chart-block">
    <div className="market-seven-chart-head">
      <Space wrap>{seriesDefs.map((item) => <span key={item.key} className="market-seven-chart-legend"><i style={{ background: item.color }} />{item.label}</span>)}</Space>
      {latest && <Text type="secondary">最新：{metricDate(latest)}</Text>}
    </div>
    <div className="market-seven-chart market-seven-stack-chart" onMouseLeave={() => setHoveredIndex(null)}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label="120日资金流分层柱状图">
        {[0.25, 0.5, 0.75].map((ratio) => {
          const y = top + plotHeight * ratio;
          return <line key={ratio} x1="0" x2={width} y1={y} y2={y} className="market-seven-grid-line" />;
        })}
        <line x1="0" x2={width} y1={zeroY} y2={zeroY} className="market-seven-zero-line" />
        {stacks.map((point, index) => {
          const x = index * slot + (slot - barWidth) / 2;
          let positiveY = zeroY;
          let negativeY = zeroY;
          const isHovered = hoveredIndex === index;
          return <g key={point.date} className="market-seven-stack-bar" onMouseEnter={() => setHoveredIndex(index)}>
            <title>{[point.date, ...point.values.map((item) => `${item.label}: ${formatMetricValue(item.key, item.value)}`)].join('\n')}</title>
            {isHovered && <rect x={index * slot} y={top} width={slot} height={plotHeight} className="market-seven-hover-band" />}
            {point.values.map((item) => {
              if (item.value === 0) return null;
              const isPositive = item.value > 0;
              const h = Math.max(1, Math.abs(item.value) * (isPositive ? positiveScale : negativeScale));
              const y = isPositive ? positiveY - h : negativeY;
              if (isPositive) positiveY = y;
              else negativeY += h;
              const canLabel = h >= 18 && barWidth >= 18;
              return <g key={item.key}>
                <rect x={x} y={y} width={barWidth} height={h} fill={item.color} opacity={isHovered ? 1 : 0.86} rx="1" />
                {canLabel && <text x={x + barWidth / 2} y={y + h / 2 + 3} textAnchor="middle" className="market-seven-stack-label">{fmt(item.value / 100000000, 1)}</text>}
              </g>;
            })}
            {points.length <= 32 && <text x={x + barWidth / 2} y={height - 9} textAnchor="middle" className="market-seven-axis-label">{point.date.slice(5)}</text>}
          </g>;
        })}
      </svg>
      {hoveredStack && <div className="market-seven-stack-tooltip">
        <strong>{hoveredStack.date}</strong>
        {hoveredStack.values.map((item) => <div key={item.key}><span><i style={{ background: item.color }} />{item.label}</span><b>{formatMetricValue(item.key, item.value)}</b></div>)}
      </div>}
    </div>
    {latestMetrics.length > 0 && <div className="market-seven-metrics">{latestMetrics.map((item) => <Tag key={item}>{item}</Tag>)}</div>}
  </div>;
}

function DataSourceTrendChart({ source, records }: { source: string; records: SevenLayerRecord[] }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const seriesDefs = TREND_CHART_DEFS[source] ?? [];
  const points = records
    .map((record) => ({ date: metricDate(record), metrics: record.metrics }))
    .filter((item) => /^\d{4}-\d{2}-\d{2}$/.test(item.date))
    .sort((a, b) => a.date.localeCompare(b.date));

  useEffect(() => {
    const container = containerRef.current;
    if (!container || points.length === 0 || seriesDefs.length === 0) return undefined;
    const chart = createChart(container, {
      width: container.clientWidth,
      height: container.clientHeight,
      layout: { background: { type: ColorType.Solid, color: '#fff' }, textColor: '#475569', fontSize: 12 },
      grid: { vertLines: { color: '#eef2f7' }, horzLines: { color: '#eef2f7' } },
      rightPriceScale: { borderColor: '#e2e8f0' },
      timeScale: { borderColor: '#e2e8f0', timeVisible: false },
      crosshair: { mode: 1 },
    });
    for (const definition of seriesDefs) {
      const data = points
        .map((point) => {
          const value = chartMetricValue(point.metrics, definition.key);
          return value == null ? null : { time: point.date as Time, value };
        })
        .filter((point): point is { time: Time; value: number } => point != null);
      if (data.length === 0) continue;
      chart.addSeries(LineSeries, {
        color: definition.color,
        lineWidth: 2,
        priceFormat: METRIC_LABELS[definition.key]?.unit === 'yuan'
          ? { type: 'price', precision: 2, minMove: 0.01 }
          : undefined,
        priceLineVisible: false,
        lastValueVisible: true,
      }).setData(data);
    }
    chart.timeScale().fitContent();
    const resize = () => {
      if (container.clientWidth > 0 && container.clientHeight > 0) {
        chart.applyOptions({ width: container.clientWidth, height: container.clientHeight });
      }
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    return () => { observer.disconnect(); chart.remove(); };
  }, [points, seriesDefs]);

  if (points.length === 0 || seriesDefs.length === 0) return null;
  const latest = [...records]
    .filter((record) => metricDate(record))
    .sort((a, b) => metricDate(b).localeCompare(metricDate(a)))[0];
  const latestMetrics = metricPreview(latest?.metrics);
  return <div className="market-seven-chart-block">
    <div className="market-seven-chart-head">
      <Space wrap>{seriesDefs.map((item) => <span key={item.key} className="market-seven-chart-legend"><i style={{ background: item.color }} />{item.label}</span>)}</Space>
      {latest && <Text type="secondary">最新：{metricDate(latest)}</Text>}
    </div>
    <div className="market-seven-chart" ref={containerRef} />
    {latestMetrics.length > 0 && <div className="market-seven-metrics">{latestMetrics.map((item) => <Tag key={item}>{item}</Tag>)}</div>}
  </div>;
}

function recordsBySource(records: SevenLayerRecord[]) {
  return records.reduce<Record<string, SevenLayerRecord[]>>((groups, record) => {
    groups[record.source] = [...(groups[record.source] ?? []), record];
    return groups;
  }, {});
}

function SevenLayerSectionContent({ section }: { section: SevenLayerSection }) {
  const groupedRecords = recordsBySource(section.records);
  const sourcePanels = section.sources.map((source) => {
    const records = groupedRecords[source] ?? [];
    const sourceErrors = section.errors.filter((error) => error.startsWith(`${source}:`));
    return {
      key: source,
      label: <Space wrap><Text strong>{source}</Text><Tag>{records.length} 条</Tag>{sourceErrors.length > 0 && <Tag color="red">异常</Tag>}</Space>,
      children: <div className="market-seven-subsection">
        {sourceErrors.length > 0 && <div className="market-seven-errors">{sourceErrors.map((error) => <Text key={error} type="secondary">{error}</Text>)}</div>}
        {TREND_CHART_DEFS[source] && records.length > 0
          ? source === '东财120日资金流' ? <FlowStackedBarChart records={records} /> : <DataSourceTrendChart source={source} records={records} />
          : records.length > 0 ? records.map((record, index) => <SevenLayerRecordItem key={`${section.key}-${record.source}-${record.title}-${index}`} record={record} />) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无记录" />}
      </div>,
    };
  });

  if (section.key === 'signal' || section.key === 'capital' || section.key === 'fundamental') {
    return <div className="market-seven-section">
      <Collapse className="market-seven-subcollapse" items={sourcePanels} />
    </div>;
  }

  return <div className="market-seven-section">
    <div className="market-seven-sources">{section.sources.map((source) => <Tag key={source}>{source}</Tag>)}</div>
    {section.errors.length > 0 && <div className="market-seven-errors">{section.errors.map((error) => <Text key={error} type="secondary">{error}</Text>)}</div>}
    {section.records.length > 0 ? section.records.map((record, index) => <SevenLayerRecordItem key={`${section.key}-${record.source}-${record.title}-${index}`} record={record} />) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无记录" />}
  </div>;
}

interface MarketDataPageProps {
  view?: 'overview' | 'watchlist' | 'detail';
  instrumentCode?: string;
  onOpenInAnalysis?: (result: ImportResult) => void;
  onOpenDetail?: (stock: StockSearchItem) => void;
}

function handleScrollKeys(event: KeyboardEvent<HTMLElement>) {
  const container = event.currentTarget;
  const page = Math.max(120, container.clientHeight * 0.85);
  const offsets: Record<string, number> = {
    ArrowDown: 48,
    ArrowUp: -48,
    PageDown: page,
    PageUp: -page,
  };
  if (event.key in offsets) {
    event.preventDefault();
    container.scrollBy({ top: offsets[event.key], behavior: 'auto' });
  } else if (event.key === 'Home' || event.key === 'End') {
    event.preventDefault();
    container.scrollTo({ top: event.key === 'Home' ? 0 : container.scrollHeight, behavior: 'auto' });
  }
}

export default function MarketDataPage({ view = 'overview', instrumentCode, onOpenInAnalysis, onOpenDetail }: MarketDataPageProps) {
  const { message } = App.useApp();
  const isWatchlistView = view === 'watchlist';
  const isDetailView = view === 'detail';
  const isResearchView = isWatchlistView || isDetailView;
  const initial = marketDataCache.watchlist ?? readWatchlist();
  const initialSelectedCode = instrumentCode || marketDataCache.selectedCode || initial[0]?.code || '600519';
  const [watchlist, setWatchlist] = useState<StockSearchItem[]>(initial);
  const [pinnedCodes, setPinnedCodes] = useState<string[]>(readPinnedCodes);
  const [selectedCode, setSelectedCode] = useState(initialSelectedCode);
  const [watchlistQuery, setWatchlistQuery] = useState('');
  const [searchText, setSearchText] = useState('');
  const [searchItems, setSearchItems] = useState<StockSearchItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [quote, setQuote] = useState<StockQuote | null>(() => marketDataCache.quotes[initialSelectedCode] ?? null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [period, setPeriod] = useState<MarketKlinePeriod>(marketDataCache.period);
  const [showChipProfile, setShowChipProfile] = useState(false);
  const [klines, setKlines] = useState<KlinePoint[]>(() => marketDataCache.klines[klineCacheKey(initialSelectedCode, marketDataCache.period)] ?? []);
  const [klineLoading, setKlineLoading] = useState(false);
  const [scoreKlines, setScoreKlines] = useState<KlinePoint[]>(() => marketDataCache.klines[klineCacheKey(initialSelectedCode, 'day')] ?? []);
  const [scoreCode, setScoreCode] = useState<string | null>(initialSelectedCode);
  const [scoreKlineLoading, setScoreKlineLoading] = useState(false);
  const [benchmarkKlines, setBenchmarkKlines] = useState<KlinePoint[]>(() => marketDataCache.klines[klineCacheKey('sh000300', 'day')] ?? []);
  const [benchmarkLoading, setBenchmarkLoading] = useState(false);
  const [indexQuotes, setIndexQuotes] = useState<StockQuote[]>(() => marketDataCache.indexQuotes ?? []);
  const [selectedIndexKeys, setSelectedIndexKeys] = useState<string[]>(readMarketIndexSelection);
  const [draftIndexKeys, setDraftIndexKeys] = useState<string[]>(readMarketIndexSelection);
  const [indexConfigOpen, setIndexConfigOpen] = useState(false);
  const [indexPreviewKlines, setIndexPreviewKlines] = useState<Record<string, KlinePoint[]>>({});
  const [indexLoading, setIndexLoading] = useState(false);
  const [marketSentiment, setMarketSentiment] = useState<MarketSentimentOverview | null>(() => marketDataCache.marketSentiment ?? null);
  const [marketSentimentLoading, setMarketSentimentLoading] = useState(false);
  const [exporting, setExporting] = useState<'analysis' | 'excel' | null>(null);
  const [reports, setReports] = useState<ResearchReport[]>(() => marketDataCache.reports[initialSelectedCode] ?? []);
  const [reportsLoading, setReportsLoading] = useState(false);
  const [sevenLayerSections, setSevenLayerSections] = useState<Partial<Record<SevenLayerSection['key'], SevenLayerSection>>>(() => marketDataCache.sevenLayer[initialSelectedCode] ?? {});
  const [sevenLayerLoading, setSevenLayerLoading] = useState<Partial<Record<SevenLayerSection['key'], boolean>>>({});
  const [agentStatus, setAgentStatus] = useState<AgentStatus | null>(marketDataCache.agentStatus ?? null);
  const [agentQuestion, setAgentQuestion] = useState(marketDataCache.agentQuestion);
  const [agentModel, setAgentModel] = useState<string | undefined>(marketDataCache.agentModel);
  const [agentRunning, setAgentRunning] = useState(false);
  const [agentResult, setAgentResult] = useState(() => marketDataCache.agentResults[initialSelectedCode]?.content ?? '');
  const [reasoningSummary, setReasoningSummary] = useState<string[]>(() => marketDataCache.agentResults[initialSelectedCode]?.reasoningSummary ?? []);
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!instrumentCode || instrumentCode === selectedCode) return;
    marketDataCache.selectedCode = instrumentCode;
    setSelectedCode(instrumentCode);
  }, [instrumentCode, selectedCode]);
  useEffect(() => { localStorage.setItem(WATCHLIST_KEY, JSON.stringify(watchlist)); marketDataCache.watchlist = watchlist; }, [watchlist]);
  useEffect(() => { localStorage.setItem(PINNED_WATCHLIST_KEY, JSON.stringify(pinnedCodes)); }, [pinnedCodes]);
  useEffect(() => { localStorage.setItem(MARKET_INDEX_SELECTION_KEY, JSON.stringify(selectedIndexKeys)); }, [selectedIndexKeys]);
  useEffect(() => { marketDataCache.selectedCode = selectedCode; }, [selectedCode]);
  useEffect(() => { marketDataCache.period = period; }, [period]);
  useEffect(() => { marketDataCache.agentQuestion = agentQuestion; }, [agentQuestion]);
  useEffect(() => { marketDataCache.agentModel = agentModel; }, [agentModel]);

  const loadQuote = useCallback(async (code: string) => {
    setQuoteLoading(true);
    try { const next = await apiFetch<StockQuote>(`/api/market-data/stocks/${code}/quote`); marketDataCache.quotes[code] = next; setQuote(next); }
    catch (e) { message.error(e instanceof Error ? e.message : '实时行情获取失败'); setQuote(null); }
    finally { setQuoteLoading(false); }
  }, [message]);
  const loadKline = useCallback(async (code: string, nextPeriod: MarketKlinePeriod, silent = false) => {
    if (!silent) setKlineLoading(true);
    try {
      const data = await apiFetch<{ items: KlinePoint[] }>(`/api/market-data/stocks/${code}/kline?period=${nextPeriod}`);
      const next = data.items ?? []; marketDataCache.klines[klineCacheKey(code, nextPeriod)] = next; setKlines(next);
    } catch (e) {
      if (!silent) {
        message.error(e instanceof Error ? e.message : 'K 线获取失败');
        setKlines([]);
      }
    }
    finally { if (!silent) setKlineLoading(false); }
  }, [message]);
  const loadIndexQuotes = useCallback(async (silent = false) => {
    if (!silent) setIndexLoading(true);
    try {
      const next = (await apiFetch<{ items: StockQuote[] }>('/api/market-data/indices/quotes')).items ?? [];
      marketDataCache.indexQuotes = next;
      setIndexQuotes(next);
    } catch (e) {
      if (!silent) message.warning(e instanceof Error ? e.message : '大盘行情获取失败');
    } finally {
      if (!silent) setIndexLoading(false);
    }
  }, [message]);
  const loadMarketSentiment = useCallback(async (silent = false, force = false) => {
    if (!silent) setMarketSentimentLoading(true);
    try {
      const path = `/api/market-data/market-sentiment${force ? '?force=true' : ''}`;
      const next = await apiFetch<MarketSentimentOverview>(path, { timeoutMs: 240000 });
      marketDataCache.marketSentiment = next;
      setMarketSentiment(next);
    } catch (e) {
      if (!silent) message.warning(e instanceof Error ? e.message : '市场情绪获取失败');
    } finally {
      if (!silent) setMarketSentimentLoading(false);
    }
  }, [message]);
  const loadReports = useCallback(async (code: string) => {
    setReportsLoading(true);
    try { const next = (await apiFetch<{ items: ResearchReport[] }>(`/api/market-data/stocks/${code}/reports`)).items ?? []; marketDataCache.reports[code] = next; setReports(next); }
    catch (error) { message.warning(error instanceof Error ? `研报加载失败：${error.message}` : '研报加载失败，可单独重试'); }
    finally { setReportsLoading(false); }
  }, [message]);
  const loadSevenLayerSection = useCallback(async (code: string, section: SevenLayerSection['key'], force = false) => {
    if (!force && marketDataCache.sevenLayer[code]?.[section]) return;
    setSevenLayerLoading((prev) => ({ ...prev, [section]: true }));
    try {
      const next = await apiFetch<SevenLayerSection>(`/api/market-data/stocks/${code}/seven-layer/${section}`, { timeoutMs: 90000 });
      marketDataCache.sevenLayer[code] = { ...(marketDataCache.sevenLayer[code] ?? {}), [section]: next };
      setSevenLayerSections((prev) => ({ ...prev, [section]: next }));
    } catch (error) {
      message.warning(error instanceof Error ? `${section} 数据源加载失败：${error.message}` : '数据源模块加载失败');
    } finally {
      setSevenLayerLoading((prev) => ({ ...prev, [section]: false }));
    }
  }, [message]);

  useEffect(() => {
    if (!isResearchView) return undefined;
    const cachedQuote = marketDataCache.quotes[selectedCode];
    const cachedKlines = marketDataCache.klines[klineCacheKey(selectedCode, period)];
    const cachedReports = marketDataCache.reports[selectedCode];
    const cachedAgent = marketDataCache.agentResults[selectedCode];
    setQuote(cachedQuote ?? null);
    setKlines(cachedKlines ?? []);
    setReports(cachedReports ?? []);
    setSevenLayerSections(marketDataCache.sevenLayer[selectedCode] ?? {});
    setSevenLayerLoading({});
    setAgentResult(cachedAgent?.content ?? '');
    setReasoningSummary(cachedAgent?.reasoningSummary ?? []);
    // Let the quote/profile request enter the Eastmoney limiter before the heavier
    // report request, so the primary card never sits behind a long report fetch.
    if (!cachedQuote || !cachedReports) {
      void (async () => { if (!cachedQuote) await loadQuote(selectedCode); if (!cachedReports) void loadReports(selectedCode); })();
    }
    if (!cachedKlines) void loadKline(selectedCode, period);
    // Period changes are requested explicitly to avoid duplicate fetches.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isResearchView, selectedCode, loadQuote, loadKline, loadReports]);
  useEffect(() => {
    if (!isResearchView) return undefined;
    let cancelled = false;
    const cacheKey = klineCacheKey(selectedCode, 'day');
    const cached = marketDataCache.klines[cacheKey];
    if (cached) {
      setScoreKlines(cached);
      setScoreCode(selectedCode);
      setScoreKlineLoading(false);
      return undefined;
    }

    setScoreKlines([]);
    setScoreCode(null);
    if (period === 'day') {
      setScoreKlineLoading(true);
      return () => { cancelled = true; };
    }

    setScoreKlineLoading(true);
    void apiFetch<{ items: KlinePoint[] }>(`/api/market-data/stocks/${selectedCode}/kline?period=day`)
      .then((data) => {
        if (cancelled) return;
        const next = data.items ?? [];
        marketDataCache.klines[cacheKey] = next;
        setScoreKlines(next);
        setScoreCode(selectedCode);
      })
      .catch((error) => {
        if (!cancelled) message.warning(error instanceof Error ? `评分日 K 加载失败：${error.message}` : '评分日 K 加载失败');
      })
      .finally(() => { if (!cancelled) setScoreKlineLoading(false); });
    return () => { cancelled = true; };
  }, [isResearchView, message, period, selectedCode]);
  useEffect(() => {
    if (!isResearchView) return;
    if (period !== 'day') return;
    const cachedForSelected = marketDataCache.klines[klineCacheKey(selectedCode, 'day')];
    if (klines.length > 0 && cachedForSelected === klines) {
      setScoreKlines(klines);
      setScoreCode(selectedCode);
      setScoreKlineLoading(false);
    } else if (!klineLoading && klines.length === 0) {
      setScoreKlineLoading(false);
    }
  }, [isResearchView, klineLoading, klines, period, selectedCode]);
  useEffect(() => {
    if (!isResearchView) return undefined;
    const cacheKey = klineCacheKey('sh000300', 'day');
    const cached = marketDataCache.klines[cacheKey];
    if (cached) {
      setBenchmarkKlines(cached);
      return undefined;
    }
    let cancelled = false;
    setBenchmarkLoading(true);
    void apiFetch<{ items: KlinePoint[] }>('/api/market-data/stocks/sh000300/kline?period=day')
      .then((data) => {
        if (cancelled) return;
        const next = data.items ?? [];
        marketDataCache.klines[cacheKey] = next;
        setBenchmarkKlines(next);
      })
      .catch((error) => {
        if (!cancelled) message.warning(error instanceof Error ? `沪深 300 日 K 加载失败：${error.message}` : '沪深 300 日 K 加载失败');
      })
      .finally(() => { if (!cancelled) setBenchmarkLoading(false); });
    return () => { cancelled = true; };
  }, [isResearchView, message]);
  useEffect(() => {
    if (!isResearchView) return;
    if (marketDataCache.agentStatus) return;
    void apiFetch<AgentStatus>('/api/market-data/research-agent/status').then((s) => { marketDataCache.agentStatus = s; setAgentStatus(s); if (!marketDataCache.agentModel) setAgentModel(s.currentModel); }).catch(() => undefined);
  }, [isResearchView]);
  useEffect(() => {
    if (isResearchView) return undefined;
    if (!marketDataCache.indexQuotes) void loadIndexQuotes();
    const timer = window.setInterval(() => void loadIndexQuotes(true), 15000);
    return () => window.clearInterval(timer);
  }, [isResearchView, loadIndexQuotes]);
  useEffect(() => {
    if (isResearchView) return undefined;
    let cancelled = false;
    void Promise.all(selectedIndexKeys.map(async (key) => {
      const option = MARKET_INDEX_OPTIONS.find((item) => item.key === key);
      if (!option) return [key, []] as const;
      const instrumentCode = marketIndexInstrumentCode(option);
      const cacheKey = klineCacheKey(instrumentCode, 'day');
      const cached = marketDataCache.klines[cacheKey];
      if (cached) return [key, cached] as const;
      try {
        const data = await apiFetch<{ items: KlinePoint[] }>(`/api/market-data/stocks/${instrumentCode}/kline?period=day`);
        const next = data.items ?? [];
        marketDataCache.klines[cacheKey] = next;
        return [key, next] as const;
      } catch {
        return [key, []] as const;
      }
    })).then((entries) => {
      if (!cancelled) setIndexPreviewKlines((current) => ({ ...current, ...Object.fromEntries(entries) }));
    });
    return () => { cancelled = true; };
  }, [isResearchView, selectedIndexKeys]);
  useEffect(() => {
    if (isResearchView) return undefined;
    void loadMarketSentiment(true);
    const timer = window.setInterval(() => void loadMarketSentiment(true, true), MARKET_SENTIMENT_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [isResearchView, loadMarketSentiment]);
  useEffect(() => {
    if (isResearchView) return undefined;
    if (marketSentimentLoading || (marketSentiment?.total ?? 0) > 0) return undefined;
    const timer = window.setInterval(() => void loadMarketSentiment(true), 5000);
    return () => window.clearInterval(timer);
  }, [isResearchView, loadMarketSentiment, marketSentiment?.total, marketSentimentLoading]);
  useEffect(() => {
    if (!isResearchView) return undefined;
    if (period !== 'intraday') return undefined;
    const timer = window.setInterval(() => {
      void loadKline(selectedCode, 'intraday', true);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [isResearchView, loadKline, period, selectedCode]);

  const search = (value: string) => {
    setSearchText(value);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (!value.trim()) { setSearchItems([]); return; }
    searchTimer.current = setTimeout(async () => {
      setSearching(true);
      try { setSearchItems((await apiFetch<{ items: StockSearchItem[] }>(`/api/market-data/stocks/search?q=${encodeURIComponent(value.trim())}`)).items ?? []); }
      catch { setSearchItems([]); }
      finally { setSearching(false); }
    }, 280);
  };
  const addStock = (stock: StockSearchItem) => {
    setWatchlist((all) => {
      const next = all.some((x) => x.code === stock.code) ? all : [...all, stock];
      localStorage.setItem(WATCHLIST_KEY, JSON.stringify(next));
      marketDataCache.watchlist = next;
      return next;
    });
    marketDataCache.selectedCode = stock.code;
    setSelectedCode(stock.code); setSearchText(''); setSearchItems([]);
  };
  const openInstrumentDetail = (stock: StockSearchItem) => {
    marketDataCache.selectedCode = stock.code;
    setSelectedCode(stock.code);
    onOpenDetail?.(stock);
  };
  const removeStock = (code: string) => setWatchlist((all) => {
    const next = all.filter((x) => x.code !== code);
    if (selectedCode === code && next[0]) setSelectedCode(next[0].code);
    return next;
  });
  const togglePinnedStock = (code: string) => setPinnedCodes((all) => (
    all.includes(code) ? all.filter((item) => item !== code) : [...all, code]
  ));
  const runAgent = async () => {
    setAgentRunning(true); setAgentResult(''); setReasoningSummary([]); setThinkingOpen(true);
    try {
      const result = await apiFetch<{ content: string; reasoningSummary: string[] }>(`/api/market-data/stocks/${selectedCode}/research`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: agentQuestion, model: agentModel }), timeoutMs: 120000,
      });
      marketDataCache.agentResults[selectedCode] = result;
      setAgentResult(result.content); setReasoningSummary(result.reasoningSummary ?? []); setThinkingOpen(false);
    } catch (e) { message.error(e instanceof Error ? e.message : 'Agent 调研失败'); }
    finally { setAgentRunning(false); }
  };

  const copyAgentResult = async () => {
    if (!agentResult) return;
    try {
      await navigator.clipboard.writeText(agentResult);
      message.success('调研报告已复制');
    } catch {
      message.error('复制失败，请检查浏览器剪贴板权限');
    }
  };

  const exportAgentResult = () => {
    if (!agentResult) return;
    const stockName = quote?.name || selectedCode;
    const date = new Date().toISOString().slice(0, 10);
    const safeName = `${stockName}-${selectedCode}-调研报告-${date}`.replace(/[\\/:*?"<>|]/g, '-');
    const blob = new Blob([`\uFEFF${agentResult}`], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${safeName}.md`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
    message.success(`已导出 ${safeName}.md`);
  };

  const changePeriod = (nextPeriod: MarketKlinePeriod) => {
    if (nextPeriod !== 'day') setShowChipProfile(false);
    setPeriod(nextPeriod);
    const cached = marketDataCache.klines[klineCacheKey(selectedCode, nextPeriod)];
    if (cached) setKlines(cached);
    else void loadKline(selectedCode, nextPeriod);
  };

  const loadDailyKlines = async () => {
    const cacheKey = klineCacheKey(selectedCode, 'day');
    const cached = marketDataCache.klines[cacheKey];
    if (cached) return cached;
    const data = await apiFetch<{ items: KlinePoint[] }>(`/api/market-data/stocks/${selectedCode}/kline?period=day`);
    const next = data.items ?? [];
    marketDataCache.klines[cacheKey] = next;
    if (period === 'day') setKlines(next);
    return next;
  };

  const buildAnalysisResult = (daily: KlinePoint[], currentQuote: StockQuote): ImportResult => {
    const candles = toCandles(daily, currentQuote);
    return {
      success: true,
      fileName: `${currentQuote.code}-${currentQuote.name}-市场数据`,
      symbol: currentQuote.code,
      dateRange: { from: candles[0]?.time ?? '', to: candles[candles.length - 1]?.time ?? '' },
      totalRows: candles.length,
      validRows: candles.length,
      errors: [],
      warnings: [],
      candles,
    };
  };

  const openInAnalysis = async () => {
    if (!quote) return;
    setExporting('analysis');
    try {
      const daily = await loadDailyKlines();
      if (daily.length === 0) throw new Error('当前标的暂无可导入的日 K 数据');
      onOpenInAnalysis?.(buildAnalysisResult(daily, quote));
      message.success(`已导入 ${quote.name} 日 K 到行情分析`);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '导入行情分析失败');
    } finally {
      setExporting(null);
    }
  };

  const exportExcel = async () => {
    if (!quote) return;
    setExporting('excel');
    try {
      const daily = await loadDailyKlines();
      if (daily.length === 0) throw new Error('当前标的暂无可导出的日 K 数据');
      const fileName = exportMarketKlinesToExcel(quote, daily);
      message.success(`已导出 ${fileName}`);
    } catch (error) {
      message.error(error instanceof Error ? error.message : 'Excel 导出失败');
    } finally {
      setExporting(null);
    }
  };

  const accent = (quote?.changePct ?? 0) > 0 ? 'up' : (quote?.changePct ?? 0) < 0 ? 'down' : '';
  const selected = watchlist.find((x) => x.code === selectedCode);
  const selectedIsInWatchlist = watchlist.some((item) => item.code === selectedCode);
  const orderedWatchlist = useMemo(() => [...watchlist].sort((a, b) => (
    Number(pinnedCodes.includes(b.code)) - Number(pinnedCodes.includes(a.code))
  )), [pinnedCodes, watchlist]);
  const filteredWatchlist = useMemo(() => {
    const query = watchlistQuery.trim().toLowerCase();
    if (!query) return orderedWatchlist;
    return orderedWatchlist.filter((item) => (
      item.code.toLowerCase().includes(query)
      || item.name.toLowerCase().includes(query)
      || item.market.toLowerCase().includes(query)
    ));
  }, [orderedWatchlist, watchlistQuery]);
  const options = useMemo(() => searchItems.map((item) => ({ value: item.code, label: <div className="market-search-option"><span><b>{item.name}</b> <Text type="secondary">{item.code}</Text></span><Tag>{item.market}</Tag></div> })), [searchItems]);
  const selectIndexQuote = (item: StockQuote) => {
    const code = `${item.market.toLowerCase()}${item.code}`;
    openInstrumentDetail({ code, name: item.name, market: item.market, type: 'index' });
  };
  const loadedSevenKeys = Object.keys(sevenLayerSections) as SevenLayerSection['key'][];
  const refreshLoadedSevenLayers = () => {
    for (const key of loadedSevenKeys) void loadSevenLayerSection(selectedCode, key, true);
  };
  const handleSevenLayerChange = (keys: string | string[]) => {
    const activeKeys = Array.isArray(keys) ? keys : [keys];
    for (const key of activeKeys) {
      if (SEVEN_LAYER_DEFS.some((item) => item.key === key)) {
        void loadSevenLayerSection(selectedCode, key as SevenLayerSection['key']);
      }
    }
  };
  const visibleIndexQuotes = selectedIndexKeys.flatMap((key) => {
    const quote = indexQuotes.find((item) => marketIndexKey(item) === key);
    return quote ? [quote] : [];
  });
  const openIndexConfig = () => {
    setDraftIndexKeys([...selectedIndexKeys]);
    setIndexConfigOpen(true);
  };
  const toggleDraftIndex = (key: string, checked: boolean) => {
    setDraftIndexKeys((current) => checked
      ? current.includes(key) || current.length >= 5 ? current : [...current, key]
      : current.filter((item) => item !== key));
  };
  const overviewUpdatedAt = marketSentiment?.updatedAt
    ?? indexQuotes.reduce<string | null>((latest, item) => (!latest || item.updatedAt > latest ? item.updatedAt : latest), null);
  const advanceRatio = marketSentiment
    ? (marketSentiment.advancers / Math.max(1, marketSentiment.advancers + marketSentiment.decliners)) * 100
    : null;

  return <main className={`market-page${isWatchlistView ? ' market-watchlist-page' : ''}${isDetailView ? ' market-detail-page' : ''}`} tabIndex={0} aria-label={`${isWatchlistView ? '我的自选' : isDetailView ? '行情详情' : '市场数据'}内容，可上下滚动`} onKeyDown={handleScrollKeys}>
    {!isWatchlistView && <>
    <section className="market-overview-header" aria-label="市场总览工具栏">
      <div className="market-overview-heading">
        <div><Title level={2}>市场总览</Title><Tag color="blue">沪深 A 股</Tag></div>
        <Text type="secondary">更新于 {overviewUpdatedAt ? new Date(overviewUpdatedAt).toLocaleString('zh-CN') : '等待行情数据'}</Text>
      </div>
      <AutoComplete className="market-search" value={searchText} options={options} onSearch={search} onSelect={(code) => { const item = searchItems.find((x) => x.code === code); if (item) openInstrumentDetail(item); }} notFoundContent={searching ? <Spin size="small" /> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="输入代码、简称或拼音" />}>
        <Input size="middle" prefix={<SearchOutlined />} suffix={<ArrowRightOutlined />} placeholder="搜索股票并查看详情，如 600519、茅台、mt" aria-label="搜索股票并查看详情" />
      </AutoComplete>
      <Space size={6}>
        <Tooltip title="设置展示的指数"><Button icon={<SettingOutlined />} aria-label="设置展示的指数" onClick={openIndexConfig} /></Tooltip>
        <Tooltip title="刷新指数与市场概况"><Button icon={<ReloadOutlined />} loading={indexLoading || marketSentimentLoading} aria-label="刷新市场总览" onClick={() => { void loadIndexQuotes(); void loadMarketSentiment(false, true); }} /></Tooltip>
      </Space>
    </section>
    <section className={`market-index-grid is-count-${visibleIndexQuotes.length}`} aria-label="当前交易日主要指数">
      {visibleIndexQuotes.map((item) => {
        const direction = (item.changePct ?? 0) > 0 ? 'up' : (item.changePct ?? 0) < 0 ? 'down' : '';
        const key = marketIndexKey(item);
        return <button type="button" className="market-index-card" key={item.code} onClick={() => selectIndexQuote(item)} aria-label={`查看${item.name}行情`}>
          <span>{item.name}<small>{item.market}</small></span>
          <strong className={direction && `market-${direction}`}>{fmt(item.price)}</strong>
          <em className={direction && `market-${direction}`}>{signed(item.changeAmount)}　{signed(item.changePct)}%</em>
          <IndexSparkline points={indexPreviewKlines[key]} label={item.name} tone={direction || 'flat'} />
          <small>成交额 {fmt(item.amountWan == null ? null : item.amountWan / 10000)} 亿</small>
        </button>;
      })}
      {indexQuotes.length === 0 && <div className="market-index-loading"><Skeleton active paragraph={{ rows: 2 }} /></div>}
      <div className="market-index-summary">
        <div><span>全市场</span><strong>{fmt(marketSentiment?.total, 0)}<small> 只</small></strong></div>
        <div><span>上涨占比</span><strong className={(advanceRatio ?? 0) >= 50 ? 'market-up' : 'market-down'}>{fmt(advanceRatio)}<small>%</small></strong></div>
        <div><span>情绪 MSI</span><strong className={(marketSentiment?.msi ?? 0) >= 0 ? 'market-up' : 'market-down'}>{signed(marketSentiment?.msi)}</strong></div>
      </div>
    </section>
    <section className="market-sentiment-section" aria-label="市场情绪与涨跌分布">
      <div className="market-dashboard-panel-head"><span><DashboardOutlined />市场概况</span><Tooltip title="刷新市场情绪"><Button size="small" type="text" icon={<ReloadOutlined />} loading={marketSentimentLoading} aria-label="刷新市场概况" onClick={() => void loadMarketSentiment(false, true)} /></Tooltip></div>
      <MarketSentimentPanel overview={marketSentiment} loading={marketSentimentLoading} onSelectStock={openInstrumentDetail} />
    </section>
    <HotSectorPanel onSelectStock={openInstrumentDetail} />
    <section className="market-selection-section" aria-label="市场技术筛选">
      <StockSelectionWorkspace
        mode="screen"
        watchlist={watchlist}
        selectedCode={selectedCode}
        pinnedCodes={pinnedCodes}
        benchmarkCandles={[]}
        onSelect={setSelectedCode}
        onTogglePin={togglePinnedStock}
        onAdd={addStock}
        onRemove={removeStock}
      />
    </section>
    </>}
    {isResearchView && <>
    {isWatchlistView && <section className="market-overview-header market-watchlist-header" aria-label="我的自选工具栏">
      <div className="market-overview-heading">
        <div><Title level={2}>我的自选</Title><Tag color="blue">{watchlist.length} 项</Tag></div>
        <Text type="secondary">集中查看行情、走势与量化评分</Text>
      </div>
      <AutoComplete className="market-search" value={searchText} options={options} onSearch={search} onSelect={(code) => { const item = searchItems.find((x) => x.code === code); if (item) addStock(item); }} notFoundContent={searching ? <Spin size="small" /> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="输入代码、简称或拼音" />}>
        <Input size="middle" prefix={<SearchOutlined />} suffix={<PlusOutlined />} placeholder="搜索股票并加入自选" aria-label="搜索并加入自选" />
      </AutoComplete>
      <Tooltip title="刷新当前行情"><Button icon={<ReloadOutlined />} loading={quoteLoading || klineLoading} aria-label="刷新当前自选行情" disabled={!selectedCode} onClick={() => { void loadQuote(selectedCode); void loadKline(selectedCode, period); }} /></Tooltip>
    </section>}
    <div className={`market-workspace${isDetailView ? ' is-detail' : ''}`}>
      {isWatchlistView && <aside className="market-watchlist"><div className="market-section-title"><span><StarFilled /> 我的自选</span><Tag>{watchlist.length}</Tag></div>
        {watchlist.length ? <>
          <div className="market-watchlist-search">
            <Input
              allowClear
              prefix={<SearchOutlined />}
              placeholder="搜索名称或代码"
              aria-label="搜索我的自选"
              value={watchlistQuery}
              onChange={(event) => setWatchlistQuery(event.target.value)}
              suffix={watchlistQuery ? <Text type="secondary">{filteredWatchlist.length}/{watchlist.length}</Text> : null}
            />
          </div>
          {filteredWatchlist.length
            ? <div className="market-watchlist-items" aria-label="自选股列表">{filteredWatchlist.map((item) => <div key={item.code} className={`market-watchlist-item${item.code === selectedCode ? ' is-active' : ''}`}><button type="button" className="market-stock-select" aria-pressed={item.code === selectedCode} onClick={() => setSelectedCode(item.code)}><strong>{pinnedCodes.includes(item.code) && <span className="market-pinned-mark" aria-label="已置顶">置顶</span>}{item.name}</strong><span>{item.code} · {item.market}</span></button><Tooltip title="移出自选"><Button type="text" danger icon={<DeleteOutlined />} aria-label={`移除 ${item.name}`} onClick={() => removeStock(item.code)} /></Tooltip></div>)}</div>
            : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="未找到匹配的自选股" />}
        </> : <Empty description="搜索并加入第一只自选股" />}
      </aside>}
      <div className="market-main">
        <Card className="market-quote-card" variant="borderless"><Skeleton loading={quoteLoading} active paragraph={{ rows: 3 }}>
          {quote ? <><div className="market-quote-head"><div className="market-quote-meta"><Space align="baseline"><Title level={3}>{quote.name}</Title><Text type="secondary">{quote.code} · {quote.market}</Text></Space><Space wrap><Tag color="blue">{quote.industry || '行业待补充'}</Tag>{quote.source.map((s) => <Tag key={s}>{s}</Tag>)}</Space><Space wrap className="market-quote-actions"><Button icon={<ReloadOutlined />} onClick={() => loadQuote(selectedCode)}>刷新行情</Button><Button icon={<ExportOutlined />} loading={exporting === 'analysis'} onClick={openInAnalysis}>导入行情分析</Button><Button icon={<DownloadOutlined />} loading={exporting === 'excel'} onClick={exportExcel}>导出 Excel</Button>{isDetailView && (selectedIsInWatchlist ? <Button icon={<CheckOutlined />} disabled>已在自选</Button> : <Button type="primary" icon={<StarOutlined />} onClick={() => { addStock({ code: selectedCode, name: quote.name, market: quote.market, type: quote.type }); message.success(`${quote.name} 已加入自选`); }}>添加自选</Button>)}</Space></div><div className="market-price-block"><span className={accent && `market-${accent}`}>{fmt(quote.price)}</span><Text className={accent && `market-${accent}`}>{fmt(quote.changeAmount)} / {fmt(quote.changePct)}%</Text></div></div>
          <div className="market-metrics-grid"><Metric label="今开 / 最高 / 最低" value={`${fmt(quote.open)} / ${fmt(quote.high)} / ${fmt(quote.low)}`} /><Metric label="昨收 / 涨停 / 跌停" value={`${fmt(quote.previousClose)} / ${fmt(quote.limitUp)} / ${fmt(quote.limitDown)}`} /><Metric label="换手率" value={`${fmt(quote.turnoverPct)}%`} /><Metric label="振幅" value={`${fmt(quote.amplitudePct)}%`} /><Metric label="量比" value={fmt(quote.volumeRatio)} /><Metric label="成交额" value={amount(quote.amountWan)} /><Metric label="PE(TTM) / PE(静)" value={`${fmt(quote.peTtm)} / ${fmt(quote.peStatic)}`} /><Metric label="PB" value={fmt(quote.pb)} /><Metric label="总市值" value={`${fmt(quote.marketCapYi)} 亿`} /><Metric label="流通市值" value={`${fmt(quote.floatMarketCapYi)} 亿`} /><Metric label="上市日期" value={quote.listDate || '—'} /><Metric label="所属行业" value={quote.industry || '—'} /></div>
          {quote.type === 'stock' && <StockSelectionScore candles={scoreCode === selectedCode ? scoreKlines : []} benchmarkCandles={benchmarkKlines} loading={scoreKlineLoading || benchmarkLoading || scoreCode !== selectedCode} />}</> : <Empty description={`无法加载 ${selected?.name ?? selectedCode} 行情`} />}
        </Skeleton></Card>
        <Card
          className="market-chart-card"
          variant="borderless"
          title={<Space wrap><span>价格走势</span><Tag color="gold">MA5/10/20</Tag><Tag color="blue">RSI14</Tag><Tag color="purple">MACD</Tag>{showChipProfile && <Tag color="volcano">筹码峰</Tag>}{period === 'intraday' && <Tag color="cyan">5秒刷新</Tag>}</Space>}
          extra={(
            <div className="market-chart-view-controls">
              <Tooltip title={period === 'day' ? (showChipProfile ? '隐藏右侧筹码峰' : '在右侧展示筹码峰') : '请先切换到日K'}>
                <Button
                  className="market-chip-toggle"
                  size="small"
                  type={showChipProfile ? 'primary' : 'default'}
                  disabled={period !== 'day'}
                  aria-pressed={showChipProfile}
                  onClick={() => setShowChipProfile((current) => !current)}
                >
                  筹码峰
                </Button>
              </Tooltip>
              <Segmented
                value={period}
                onChange={(value) => changePeriod(value as MarketKlinePeriod)}
                options={[
                  { label: '分时', value: 'intraday' },
                  { label: '日K', value: 'day' },
                  { label: '周K', value: 'week' },
                  { label: '年K', value: 'year' },
                ]}
              />
            </div>
          )}
        >
          <Spin spinning={klineLoading}>
            <MarketKlineChart data={klines} period={period} previousClose={quote?.previousClose} showChipProfile={showChipProfile} />
          </Spin>
        </Card>
        <div className="market-lower-grid">
          <Card className="market-reports-card" variant="borderless" title={<Space><FileSearchOutlined />机构研报</Space>} extra={<Space><Tag>{reports.length} 篇</Tag><Tooltip title="仅刷新机构研报"><Button size="small" icon={<ReloadOutlined />} loading={reportsLoading} onClick={() => loadReports(selectedCode)}>刷新</Button></Tooltip></Space>}><Table<ResearchReport> size="small" loading={reportsLoading} rowKey="infoCode" scroll={{ x: 560 }} pagination={{ pageSize: 6, hideOnSinglePage: true, responsive: true }} dataSource={reports} columns={[{ title: '日期', dataIndex: 'publishDate', width: 104 }, { title: '机构', dataIndex: 'organization', width: 100, ellipsis: true }, { title: '标题', dataIndex: 'title', width: 280, ellipsis: true, render: (title, row) => row.pdfUrl ? <a href={row.pdfUrl} target="_blank" rel="noreferrer">{title}</a> : title }, { title: '评级', dataIndex: 'rating', width: 76, render: (v) => v ? <Tag color="blue">{v}</Tag> : '—' }]} locale={{ emptyText: <Empty description="暂无机构研报，可点击右上角刷新" /> }} /></Card>
          <Card className="market-agent-card" variant="borderless" title={<Space><RobotOutlined />调研 Agent</Space>} extra={<Tag color={agentStatus?.configured ? 'green' : 'orange'}>{agentStatus?.configured ? agentStatus.currentModel : '待配置'}</Tag>}>
            <div className="agent-workflow">{(agentStatus?.workflow ?? ['实时行情', 'K线趋势', '机构研报', '证据整理']).map((step, i) => <span key={step}><b>{i + 1}</b>{step}</span>)}</div>
            <Input.TextArea rows={3} value={agentQuestion} onChange={(e) => setAgentQuestion(e.target.value)} maxLength={1000} aria-label="调研问题" />
            <div className="agent-actions"><Select value={agentModel} onChange={setAgentModel} options={(agentStatus?.availableModels ?? []).map((m) => ({ label: m, value: m }))} style={{ minWidth: 180 }} /><Button type="primary" icon={<RobotOutlined />} loading={agentRunning} disabled={!agentStatus?.configured} onClick={runAgent}>运行调研</Button></div>
            <div className="agent-output-actions">
              <Text type="secondary">输出内容</Text>
              <Space wrap>
                <Button size="small" icon={<CopyOutlined />} disabled={!agentResult || agentRunning} onClick={copyAgentResult}>复制报告</Button>
                <Button size="small" icon={<DownloadOutlined />} disabled={!agentResult || agentRunning} onClick={exportAgentResult}>导出 Markdown</Button>
              </Space>
            </div>
            {(agentRunning || reasoningSummary.length > 0) && <Collapse className="agent-reasoning" activeKey={thinkingOpen ? ['reasoning'] : []} onChange={(keys) => setThinkingOpen((Array.isArray(keys) ? keys : [keys]).includes('reasoning'))} items={[{ key: 'reasoning', label: <Space>{agentRunning ? <Spin size="small" /> : <CheckCircleOutlined className="agent-process-done" />}调研过程摘要{!agentRunning && <Text type="secondary">（已完成，自动折叠）</Text>}</Space>, children: <ol>{(reasoningSummary.length ? reasoningSummary : ['读取实时行情与估值字段', '加载日K、周K与技术趋势', '整理机构研报与评级', '区分事实、推断和数据缺口', '生成结构化 Markdown 报告']).map((step) => <li key={step}>{step}</li>)}</ol> }]} />}
            {agentResult ? <article className="agent-result markdown-preview"><ReactMarkdown remarkPlugins={[remarkGfm]}>{agentResult}</ReactMarkdown></article> : !agentRunning && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={agentStatus?.configured ? 'Agent 将调用行情、K线和研报数据生成调研报告' : '复用策略工作室的模型配置后即可运行'} />}
          </Card>
        </div>
        <Card
          className="market-seven-card"
          variant="borderless"
          title={<Space><DatabaseOutlined />数据源</Space>}
          extra={<Button size="small" icon={<ReloadOutlined />} disabled={loadedSevenKeys.length === 0} onClick={refreshLoadedSevenLayers}>刷新已加载</Button>}
        >
          <Collapse
            className="market-seven-collapse"
            onChange={handleSevenLayerChange}
            items={SEVEN_LAYER_DEFS.map((definition) => {
              const section = sevenLayerSections[definition.key];
              const loading = Boolean(sevenLayerLoading[definition.key]);
              return {
                key: definition.key,
                label: <Space wrap><Text strong>{definition.title}</Text>{section && <Tag color={statusColor(section.status)}>{section.status}</Tag>}<Text type="secondary">{section?.summary ?? definition.summary}</Text>{loading && <Spin size="small" />}</Space>,
                children: <Spin spinning={loading}>
                  {section ? <SevenLayerSectionContent section={section} /> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="展开后加载该模块" />}
                </Spin>,
              };
            })}
          />
        </Card>
      </div>
    </div>
    {isWatchlistView && <section className="market-selection-section" aria-label="自选评分排名">
      <StockSelectionWorkspace
        mode="ranking"
        watchlist={watchlist}
        selectedCode={selectedCode}
        pinnedCodes={pinnedCodes}
        benchmarkCandles={benchmarkKlines}
        onSelect={setSelectedCode}
        onTogglePin={togglePinnedStock}
        onAdd={addStock}
        onRemove={removeStock}
      />
    </section>}
    </>}
    {!isResearchView && <Modal
      className="market-index-config-modal"
      title="设置总览指数"
      open={indexConfigOpen}
      okText="应用"
      cancelText="取消"
      okButtonProps={{ disabled: draftIndexKeys.length === 0 }}
      onCancel={() => setIndexConfigOpen(false)}
      onOk={() => {
        if (!draftIndexKeys.length) return;
        setSelectedIndexKeys(MARKET_INDEX_OPTIONS.filter((item) => draftIndexKeys.includes(item.key)).map((item) => item.key));
        setIndexConfigOpen(false);
      }}
    >
      <Text type="secondary">选择 1–5 个指数用于市场总览，设置会保存在当前浏览器。</Text>
      <div className="market-index-config-list">
        {MARKET_INDEX_OPTIONS.map((item) => {
          const checked = draftIndexKeys.includes(item.key);
          return <label key={item.key} className={checked ? 'is-selected' : ''}>
            <Checkbox
              checked={checked}
              disabled={!checked && draftIndexKeys.length >= 5}
              onChange={(event) => toggleDraftIndex(item.key, event.target.checked)}
            />
            <span><strong>{item.name}</strong><small>{item.code} · {item.market}</small></span>
          </label>;
        })}
      </div>
      <Text type="secondary">已选择 {draftIndexKeys.length} / 5</Text>
    </Modal>}
  </main>;
}
