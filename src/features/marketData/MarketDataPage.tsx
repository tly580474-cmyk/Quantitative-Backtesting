import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { App, AutoComplete, Button, Card, Empty, Input, Segmented, Select, Skeleton, Space, Spin, Table, Tag, Tooltip, Typography } from 'antd';
import { ApiOutlined, DeleteOutlined, FileSearchOutlined, PlusOutlined, ReloadOutlined, RobotOutlined, SearchOutlined, StarFilled } from '@ant-design/icons';
import { apiFetch } from '../../api/client';
import MarketKlineChart from './MarketKlineChart';
import type { AgentStatus, KlinePoint, ResearchReport, StockQuote, StockSearchItem } from './types';

const { Text, Title, Paragraph } = Typography;
const WATCHLIST_KEY = 'quant-market-watchlist-v1';
const DEFAULT_WATCHLIST: StockSearchItem[] = [
  { code: '600519', name: '贵州茅台', market: 'SH', type: 'stock' },
  { code: '000001', name: '平安银行', market: 'SZ', type: 'stock' },
];

function readWatchlist(): StockSearchItem[] {
  try {
    const stored = JSON.parse(localStorage.getItem(WATCHLIST_KEY) ?? '[]') as StockSearchItem[];
    return Array.isArray(stored) && stored.length ? stored : DEFAULT_WATCHLIST;
  } catch { return DEFAULT_WATCHLIST; }
}
function fmt(value: number | null | undefined, digits = 2) {
  return value == null ? '—' : value.toLocaleString('zh-CN', { maximumFractionDigits: digits });
}
function amount(value: number | null) {
  if (value == null) return '—';
  return value >= 10000 ? `${fmt(value / 10000)} 亿` : `${fmt(value)} 万`;
}
function Metric({ label, value }: { label: string; value: string }) {
  return <div className="market-metric"><Text type="secondary">{label}</Text><Text strong>{value}</Text></div>;
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

export default function MarketDataPage() {
  const { message } = App.useApp();
  const initial = readWatchlist();
  const [watchlist, setWatchlist] = useState<StockSearchItem[]>(initial);
  const [selectedCode, setSelectedCode] = useState(initial[0]?.code ?? '600519');
  const [searchText, setSearchText] = useState('');
  const [searchItems, setSearchItems] = useState<StockSearchItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [quote, setQuote] = useState<StockQuote | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [period, setPeriod] = useState<'day' | 'week' | 'year'>('day');
  const [klines, setKlines] = useState<KlinePoint[]>([]);
  const [klineLoading, setKlineLoading] = useState(false);
  const [reports, setReports] = useState<ResearchReport[]>([]);
  const [reportsLoading, setReportsLoading] = useState(false);
  const [agentStatus, setAgentStatus] = useState<AgentStatus | null>(null);
  const [agentQuestion, setAgentQuestion] = useState('请综合评估当前估值、趋势、机构观点和主要风险。');
  const [agentModel, setAgentModel] = useState<string>();
  const [agentRunning, setAgentRunning] = useState(false);
  const [agentResult, setAgentResult] = useState('');
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => localStorage.setItem(WATCHLIST_KEY, JSON.stringify(watchlist)), [watchlist]);

  const loadQuote = useCallback(async (code: string) => {
    setQuoteLoading(true);
    try { setQuote(await apiFetch<StockQuote>(`/api/market-data/stocks/${code}/quote`)); }
    catch (e) { message.error(e instanceof Error ? e.message : '实时行情获取失败'); setQuote(null); }
    finally { setQuoteLoading(false); }
  }, [message]);
  const loadKline = useCallback(async (code: string, nextPeriod: typeof period) => {
    setKlineLoading(true);
    try {
      const data = await apiFetch<{ items: KlinePoint[] }>(`/api/market-data/stocks/${code}/kline?period=${nextPeriod}`);
      setKlines(data.items ?? []);
    } catch (e) { message.error(e instanceof Error ? e.message : 'K 线获取失败'); setKlines([]); }
    finally { setKlineLoading(false); }
  }, [message]);
  const loadReports = useCallback(async (code: string) => {
    setReportsLoading(true);
    try { setReports((await apiFetch<{ items: ResearchReport[] }>(`/api/market-data/stocks/${code}/reports`)).items ?? []); }
    catch { setReports([]); }
    finally { setReportsLoading(false); }
  }, []);

  useEffect(() => {
    setAgentResult('');
    // Let the quote/profile request enter the Eastmoney limiter before the heavier
    // report request, so the primary card never sits behind a long report fetch.
    void (async () => { await loadQuote(selectedCode); void loadReports(selectedCode); })();
    void loadKline(selectedCode, period);
    // Period changes are requested explicitly to avoid duplicate fetches.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCode, loadQuote, loadKline, loadReports]);
  useEffect(() => {
    void apiFetch<AgentStatus>('/api/market-data/research-agent/status').then((s) => { setAgentStatus(s); setAgentModel(s.currentModel); }).catch(() => undefined);
  }, []);

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
    setWatchlist((all) => all.some((x) => x.code === stock.code) ? all : [...all, stock]);
    setSelectedCode(stock.code); setSearchText(''); setSearchItems([]);
  };
  const removeStock = (code: string) => setWatchlist((all) => {
    const next = all.filter((x) => x.code !== code);
    if (selectedCode === code && next[0]) setSelectedCode(next[0].code);
    return next;
  });
  const runAgent = async () => {
    setAgentRunning(true); setAgentResult('');
    try {
      const result = await apiFetch<{ content: string }>(`/api/market-data/stocks/${selectedCode}/research`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: agentQuestion, model: agentModel }),
      });
      setAgentResult(result.content);
    } catch (e) { message.error(e instanceof Error ? e.message : 'Agent 调研失败'); }
    finally { setAgentRunning(false); }
  };

  const accent = (quote?.changePct ?? 0) > 0 ? 'up' : (quote?.changePct ?? 0) < 0 ? 'down' : '';
  const selected = watchlist.find((x) => x.code === selectedCode);
  const options = useMemo(() => searchItems.map((item) => ({ value: item.code, label: <div className="market-search-option"><span><b>{item.name}</b> <Text type="secondary">{item.code}</Text></span><Tag>{item.market}</Tag></div> })), [searchItems]);

  return <main className="market-page" tabIndex={0} aria-label="市场数据内容，可上下滚动" onKeyDown={handleScrollKeys}>
    <section className="market-hero">
      <div><Space><ApiOutlined /><Text type="secondary">A 股全栈数据</Text></Space><Title level={2}>市场数据与个股调研</Title><Paragraph>搜索全市场股票，按需加入自选。行情不再受本地证券库覆盖率限制。</Paragraph></div>
      <AutoComplete className="market-search" value={searchText} options={options} onSearch={search} onSelect={(code) => { const item = searchItems.find((x) => x.code === code); if (item) addStock(item); }} notFoundContent={searching ? <Spin size="small" /> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="输入代码、简称或拼音" />}>
        <Input size="large" prefix={<SearchOutlined />} suffix={<PlusOutlined />} placeholder="搜索 5000+ A 股，如 600519、茅台、mt" aria-label="搜索股票" />
      </AutoComplete>
    </section>
    <div className="market-workspace">
      <aside className="market-watchlist"><div className="market-section-title"><span><StarFilled /> 我的自选</span><Tag>{watchlist.length}</Tag></div>
        {watchlist.length ? <div className="market-watchlist-items">{watchlist.map((item) => <div key={item.code} className={`market-watchlist-item${item.code === selectedCode ? ' is-active' : ''}`}><button type="button" className="market-stock-select" aria-pressed={item.code === selectedCode} onClick={() => setSelectedCode(item.code)}><strong>{item.name}</strong><span>{item.code} · {item.market}</span></button><Tooltip title="移出自选"><Button type="text" danger icon={<DeleteOutlined />} aria-label={`移除 ${item.name}`} onClick={() => removeStock(item.code)} /></Tooltip></div>)}</div> : <Empty description="搜索并加入第一只自选股" />}
      </aside>
      <div className="market-main">
        <Card className="market-quote-card" variant="borderless"><Skeleton loading={quoteLoading} active paragraph={{ rows: 3 }}>
          {quote ? <><div className="market-quote-head"><div><Space align="baseline"><Title level={3}>{quote.name}</Title><Text type="secondary">{quote.code} · {quote.market}</Text></Space><Space wrap><Tag color="blue">{quote.industry || '行业待补充'}</Tag>{quote.source.map((s) => <Tag key={s}>{s}</Tag>)}</Space></div><div className="market-price-block"><span className={accent && `market-${accent}`}>{fmt(quote.price)}</span><Text className={accent && `market-${accent}`}>{fmt(quote.changeAmount)} / {fmt(quote.changePct)}%</Text></div><Button icon={<ReloadOutlined />} onClick={() => loadQuote(selectedCode)}>刷新行情</Button></div>
          <div className="market-metrics-grid"><Metric label="今开 / 最高 / 最低" value={`${fmt(quote.open)} / ${fmt(quote.high)} / ${fmt(quote.low)}`} /><Metric label="昨收 / 涨停 / 跌停" value={`${fmt(quote.previousClose)} / ${fmt(quote.limitUp)} / ${fmt(quote.limitDown)}`} /><Metric label="换手率" value={`${fmt(quote.turnoverPct)}%`} /><Metric label="振幅" value={`${fmt(quote.amplitudePct)}%`} /><Metric label="量比" value={fmt(quote.volumeRatio)} /><Metric label="成交额" value={amount(quote.amountWan)} /><Metric label="PE(TTM) / PE(静)" value={`${fmt(quote.peTtm)} / ${fmt(quote.peStatic)}`} /><Metric label="PB" value={fmt(quote.pb)} /><Metric label="总市值" value={`${fmt(quote.marketCapYi)} 亿`} /><Metric label="流通市值" value={`${fmt(quote.floatMarketCapYi)} 亿`} /><Metric label="上市日期" value={quote.listDate || '—'} /><Metric label="所属行业" value={quote.industry || '—'} /></div></> : <Empty description={`无法加载 ${selected?.name ?? selectedCode} 行情`} />}
        </Skeleton></Card>
        <Card className="market-chart-card" variant="borderless" title="价格走势" extra={<Segmented value={period} onChange={(v) => { const p = v as typeof period; setPeriod(p); void loadKline(selectedCode, p); }} options={[{ label: '日K', value: 'day' }, { label: '周K', value: 'week' }, { label: '年K', value: 'year' }]} />}><Spin spinning={klineLoading}><MarketKlineChart data={klines} /></Spin></Card>
        <div className="market-lower-grid">
          <Card className="market-reports-card" variant="borderless" title={<Space><FileSearchOutlined />机构研报</Space>} extra={<Tag>{reports.length} 篇</Tag>}><Table<ResearchReport> size="small" loading={reportsLoading} rowKey="infoCode" scroll={{ x: 560 }} pagination={{ pageSize: 6, hideOnSinglePage: true, responsive: true }} dataSource={reports} columns={[{ title: '日期', dataIndex: 'publishDate', width: 104 }, { title: '机构', dataIndex: 'organization', width: 100, ellipsis: true }, { title: '标题', dataIndex: 'title', width: 280, ellipsis: true, render: (title, row) => row.pdfUrl ? <a href={row.pdfUrl} target="_blank" rel="noreferrer">{title}</a> : title }, { title: '评级', dataIndex: 'rating', width: 76, render: (v) => v ? <Tag color="blue">{v}</Tag> : '—' }]} locale={{ emptyText: <Empty description="暂无机构研报" /> }} /></Card>
          <Card className="market-agent-card" variant="borderless" title={<Space><RobotOutlined />调研 Agent</Space>} extra={<Tag color={agentStatus?.configured ? 'green' : 'orange'}>{agentStatus?.configured ? agentStatus.currentModel : '待配置'}</Tag>}>
            <div className="agent-workflow">{(agentStatus?.workflow ?? ['实时行情', 'K线趋势', '机构研报', '证据整理']).map((step, i) => <span key={step}><b>{i + 1}</b>{step}</span>)}</div>
            <Input.TextArea rows={3} value={agentQuestion} onChange={(e) => setAgentQuestion(e.target.value)} maxLength={1000} aria-label="调研问题" />
            <div className="agent-actions"><Select value={agentModel} onChange={setAgentModel} options={(agentStatus?.availableModels ?? []).map((m) => ({ label: m, value: m }))} style={{ minWidth: 180 }} /><Button type="primary" icon={<RobotOutlined />} loading={agentRunning} disabled={!agentStatus?.configured} onClick={runAgent}>运行调研</Button></div>
            {agentResult ? <pre className="agent-result">{agentResult}</pre> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={agentStatus?.configured ? 'Agent 将调用行情、K线和研报数据生成调研报告' : '复用策略工作室的模型配置后即可运行'} />}
          </Card>
        </div>
      </div>
    </div>
  </main>;
}
