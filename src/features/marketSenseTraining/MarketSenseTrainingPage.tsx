import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AimOutlined,
  ArrowDownOutlined,
  ArrowRightOutlined,
  ArrowUpOutlined,
  BarChartOutlined,
  CheckCircleOutlined,
  ClearOutlined,
  EyeInvisibleOutlined,
  FastForwardOutlined,
  LineOutlined,
  MinusOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  SelectOutlined,
  TrophyOutlined,
  UndoOutlined,
} from '@ant-design/icons';
import { App as AntApp, Button, Checkbox, InputNumber, Popover, Progress, Spin, Tag, Tooltip } from 'antd';
import { apiFetch } from '@/api/client';
import type { KlinePoint } from '@/features/marketData/types';
import { useDarkMode } from '@/theme';
import TrainingChart, {
  type TrainingChartSnapshot,
  type TrainingDrawingMode,
  type TrainingIndicator,
} from './TrainingChart';
import type { TrainingDrawing, TrainingDrawingPoint } from './TrainingDrawingPrimitive';
import {
  availableToSell,
  calculateFullPositionQuantity,
  createTrainingPortfolio,
  executeTrainingTrade,
  portfolioEquity,
  recordEquity,
  summarizeTraining,
  TRAINING_INITIAL_CASH,
  type TrainingPortfolio,
} from './engine';
import {
  eligibleDecisionIndices,
  reconstructQfqFromPreviousClose,
  toTrainingCandidate,
  type TrainingCandidate,
} from './universe';
import './marketSenseTraining.workbench.css';

const INITIAL_VISIBLE_BARS = 80;
const TARGET_FUTURE_BARS = 120;
const MIN_FUTURE_BARS = 50;
const TRAINING_CANDIDATE_CONCURRENCY = 4;
const TRAINING_POOL_CACHE_TTL_MS = 10 * 60 * 1000;

let trainingPoolCache: { expiresAt: number; items: TrainingCandidate[] } | null = null;

interface KlineResponse {
  items: KlinePoint[];
  source?: string;
}

interface TrainingInstrument {
  code: string;
  name: string;
  market: string;
}

interface InstrumentListResponse {
  items: import('@/features/marketData/types').Instrument[];
  total: number;
}

type Phase = 'idle' | 'loading' | 'active' | 'finished' | 'error';

interface TrainingSessionCache {
  phase: 'active' | 'finished';
  instrument: TrainingInstrument | null;
  sessionBars: KlinePoint[];
  cursor: number;
  lots: number;
  portfolio: TrainingPortfolio;
  indicators: TrainingIndicator[];
  drawingMode: TrainingDrawingMode;
  drawings: TrainingDrawing[];
  draftPoint: TrainingDrawingPoint | null;
}

const TRAINING_SESSION_STORAGE_KEY = 'market-sense-training-session-v1';

function readTrainingSessionCache(): TrainingSessionCache | null {
  if (typeof sessionStorage === 'undefined') return null;
  try {
    return JSON.parse(sessionStorage.getItem(TRAINING_SESSION_STORAGE_KEY) ?? 'null') as TrainingSessionCache | null;
  } catch {
    return null;
  }
}

function writeTrainingSessionCache(value: TrainingSessionCache | null): void {
  if (typeof sessionStorage === 'undefined') return;
  if (value) sessionStorage.setItem(TRAINING_SESSION_STORAGE_KEY, JSON.stringify(value));
  else sessionStorage.removeItem(TRAINING_SESSION_STORAGE_KEY);
}

function money(value: number) {
  return value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function pct(value: number) {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}

function chartNumber(value: number | null | undefined, digits = 2) {
  return value == null || !Number.isFinite(value) ? '—' : value.toFixed(digits);
}

function compactVolume(value: number) {
  if (!Number.isFinite(value)) return '—';
  if (Math.abs(value) >= 100_000_000) return `${(value / 100_000_000).toFixed(2)}亿`;
  if (Math.abs(value) >= 10_000) return `${(value / 10_000).toFixed(2)}万`;
  return Math.round(value).toLocaleString('zh-CN');
}

function shuffle<T>(items: readonly T[]): T[] {
  const next = [...items];
  for (let index = next.length - 1; index > 0; index -= 1) {
    const target = Math.floor(Math.random() * (index + 1));
    [next[index], next[target]] = [next[target], next[index]];
  }
  return next;
}

function cleanBars(items: KlinePoint[]): KlinePoint[] {
  return items
    .filter((bar) => [bar.open, bar.high, bar.low, bar.close].every(
      (value) => Number.isFinite(value) && value > 0,
    ))
    .sort((a, b) => a.date.localeCompare(b.date));
}

async function loadTrainingPool(): Promise<TrainingCandidate[]> {
  if (trainingPoolCache && trainingPoolCache.expiresAt > Date.now()) {
    return trainingPoolCache.items;
  }
  const fetchPage = (market: 'SH' | 'SZ', offset: number, limit: number) => apiFetch<InstrumentListResponse>(
    `/api/instruments?market=${market}&type=stock&status=active&excludeDelisted=true&excludeSt=true&offset=${offset}&limit=${limit}`,
  );
  const [shSummary, szSummary] = await Promise.all([
    fetchPage('SH', 0, 1),
    fetchPage('SZ', 0, 1),
  ]);
  const totals = { SH: shSummary.total, SZ: szSummary.total } as const;
  const grandTotal = totals.SH + totals.SZ;
  if (grandTotal === 0) return [];

  const loadCircularSample = async (market: 'SH' | 'SZ', sampleSize: number) => {
    const total = totals[market];
    if (total === 0 || sampleSize === 0) return [];
    const size = Math.min(total, sampleSize);
    const offset = Math.floor(Math.random() * total);
    const firstSize = Math.min(size, total - offset);
    const first = await fetchPage(market, offset, firstSize);
    const remaining = size - first.items.length;
    if (remaining <= 0) return first.items;
    const wrapped = await fetchPage(market, 0, remaining);
    return [...first.items, ...wrapped.items];
  };

  const targetSampleSize = Math.min(300, grandTotal);
  const shSampleSize = Math.min(totals.SH, Math.round(targetSampleSize * totals.SH / grandTotal));
  const szSampleSize = Math.min(totals.SZ, targetSampleSize - shSampleSize);
  const instruments = (await Promise.all([
    loadCircularSample('SH', shSampleSize),
    loadCircularSample('SZ', szSampleSize),
  ])).flat();
  const candidates = instruments
    .filter((item) => (item.recordCount ?? 0) >= INITIAL_VISIBLE_BARS + MIN_FUTURE_BARS)
    .map(toTrainingCandidate)
    .filter((item): item is TrainingCandidate => item !== null);
  trainingPoolCache = { expiresAt: Date.now() + TRAINING_POOL_CACHE_TTL_MS, items: candidates };
  return candidates;
}

function trainingHistoryStartDate(): string {
  const date = new Date();
  date.setFullYear(date.getFullYear() - 10);
  return date.toISOString().slice(0, 10);
}

async function loadCandidateSession(candidate: TrainingCandidate): Promise<KlinePoint[] | null> {
  const response = await apiFetch<KlineResponse>(
    `/api/market-data/stocks/${candidate.code}/kline?period=day&adjustmentMode=none&fullHistory=true&startDate=${trainingHistoryStartDate()}`,
  );
  const bars = reconstructQfqFromPreviousClose(cleanBars(response.items ?? []));
  const decisionIndices = eligibleDecisionIndices(bars, INITIAL_VISIBLE_BARS, MIN_FUTURE_BARS);
  if (decisionIndices.length === 0) return null;
  const start = decisionIndices[Math.floor(Math.random() * decisionIndices.length)];
  return bars.slice(
    start - INITIAL_VISIBLE_BARS + 1,
    Math.min(bars.length, start + TARGET_FUTURE_BARS + 1),
  );
}

export default function MarketSenseTrainingPage() {
  const { message } = AntApp.useApp();
  const isDark = useDarkMode();
  const initialCache = readTrainingSessionCache();
  const [phase, setPhase] = useState<Phase>(initialCache?.phase ?? 'idle');
  const [instrument, setInstrument] = useState<TrainingInstrument | null>(initialCache?.instrument ?? null);
  const [sessionBars, setSessionBars] = useState<KlinePoint[]>(initialCache?.sessionBars ?? []);
  const [cursor, setCursor] = useState(initialCache?.cursor ?? INITIAL_VISIBLE_BARS - 1);
  const [lots, setLots] = useState(initialCache?.lots ?? 1);
  const [portfolio, setPortfolio] = useState<TrainingPortfolio>(initialCache?.portfolio ?? createTrainingPortfolio());
  const [error, setError] = useState('');
  const [indicators, setIndicators] = useState<TrainingIndicator[]>(initialCache?.indicators ?? ['ma']);
  const [drawingMode, setDrawingMode] = useState<TrainingDrawingMode>(initialCache?.drawingMode ?? 'none');
  const [drawings, setDrawings] = useState<TrainingDrawing[]>(initialCache?.drawings ?? []);
  const [draftPoint, setDraftPoint] = useState<TrainingDrawingPoint | null>(initialCache?.draftPoint ?? null);
  const [chartSnapshot, setChartSnapshot] = useState<TrainingChartSnapshot | null>(null);

  const currentBar = sessionBars[cursor];
  const previousBar = cursor > 0 ? sessionBars[cursor - 1] : undefined;
  const currentChangePercent = currentBar && previousBar?.close
    ? (currentBar.close - previousBar.close) / previousBar.close * 100
    : 0;
  const displayedBar = chartSnapshot?.bar ?? currentBar;
  const changePercent = chartSnapshot?.changePercent ?? currentChangePercent;
  const changeTone = changePercent > 0 ? 'is-up' : changePercent < 0 ? 'is-down' : 'is-flat';
  const changeText = `${changePercent > 0 ? '+' : ''}${chartNumber(changePercent)}%`;
  const visibleBars = useMemo(
    () => phase === 'finished' ? sessionBars : sessionBars.slice(0, cursor + 1),
    [cursor, phase, sessionBars],
  );
  const equity = currentBar ? portfolioEquity(portfolio, currentBar.close) : TRAINING_INITIAL_CASH;
  const unrealizedPnl = currentBar
    ? (currentBar.close - portfolio.averageCost) * portfolio.quantity
    : 0;
  const sellable = availableToSell(portfolio, cursor);
  const totalSteps = Math.max(1, sessionBars.length - INITIAL_VISIBLE_BARS);
  const completedSteps = Math.max(0, cursor - INITIAL_VISIBLE_BARS + 1);
  const progress = Math.min(100, completedSteps / totalSteps * 100);
  const summary = useMemo(
    () => phase === 'finished' && currentBar
      ? summarizeTraining(portfolio, currentBar.close)
      : null,
    [currentBar, phase, portfolio],
  );
  const trainingStartBar = sessionBars[INITIAL_VISIBLE_BARS - 1];
  const stockPeriodReturnPct = trainingStartBar && currentBar && trainingStartBar.close > 0
    ? (currentBar.close / trainingStartBar.close - 1) * 100
    : 0;

  useEffect(() => {
    if (phase !== 'active' && phase !== 'finished') return;
    writeTrainingSessionCache({
      phase,
      instrument,
      sessionBars,
      cursor,
      lots,
      portfolio,
      indicators,
      drawingMode,
      drawings,
      draftPoint,
    });
  }, [cursor, draftPoint, drawingMode, drawings, indicators, instrument, lots, phase, portfolio, sessionBars]);

  const startTraining = useCallback(async () => {
    writeTrainingSessionCache(null);
    setPhase('loading');
    setError('');
    setInstrument(null);
    setSessionBars([]);
    setPortfolio(createTrainingPortfolio());
    setDrawingMode('none');
    setDrawings([]);
    setDraftPoint(null);
    setChartSnapshot(null);
    let trainingPool: TrainingCandidate[];
    try {
      trainingPool = shuffle(await loadTrainingPool());
    } catch {
      setError('无法读取本地 A 股股票池，请确认数据库与证券目录服务可用。');
      setPhase('error');
      return;
    }
    for (let offset = 0; offset < trainingPool.length; offset += TRAINING_CANDIDATE_CONCURRENCY) {
      const batch = trainingPool.slice(offset, offset + TRAINING_CANDIDATE_CONCURRENCY);
      const results = await Promise.all(batch.map(async (candidate) => {
        try {
          return { candidate, bars: await loadCandidateSession(candidate) };
        } catch {
          return { candidate, bars: null };
        }
      }));
      const eligible = results.filter(
        (result): result is { candidate: TrainingCandidate; bars: KlinePoint[] } => result.bars !== null,
      );
      if (eligible.length > 0) {
        const selected = eligible[Math.floor(Math.random() * eligible.length)];
        const nextBars = selected.bars;
        const initialPortfolio = recordEquity(
          createTrainingPortfolio(),
          nextBars[INITIAL_VISIBLE_BARS - 1],
        );
        setInstrument(selected.candidate);
        setSessionBars(nextBars);
        setCursor(INITIAL_VISIBLE_BARS - 1);
        setPortfolio(initialPortfolio);
        setLots(1);
        setPhase('active');
        return;
      }
    }
    setError('没有找到足够长度的本地日线数据，请先在数据中心同步历史行情。');
    setPhase('error');
  }, []);

  const finishTraining = useCallback(() => {
    if (!currentBar) return;
    setPortfolio((value) => recordEquity(value, currentBar));
    setPhase('finished');
  }, [currentBar]);

  const nextBar = useCallback(() => {
    if (phase !== 'active' || !currentBar) return;
    if (cursor >= sessionBars.length - 1) {
      finishTraining();
      return;
    }
    const nextCursor = cursor + 1;
    setCursor(nextCursor);
    setPortfolio((value) => recordEquity(value, sessionBars[nextCursor]));
  }, [currentBar, cursor, finishTraining, phase, sessionBars]);

  const trade = useCallback((side: 'buy' | 'sell', quantity: number) => {
    if (phase !== 'active' || !currentBar) return;
    const result = executeTrainingTrade(portfolio, side, quantity, currentBar, cursor);
    if (result.error) {
      message.warning(result.error);
      return;
    }
    setPortfolio(result.portfolio);
    const executed = result.portfolio.trades[result.portfolio.trades.length - 1];
    message.success(`${side === 'buy' ? '买入' : '卖出'} ${executed.quantity / 100} 手`);
  }, [currentBar, cursor, message, phase, portfolio]);

  const buyByRatio = useCallback((ratio: number) => {
    if (!currentBar) return;
    const full = calculateFullPositionQuantity(portfolio, currentBar.close);
    const quantity = Math.floor(full * ratio / 100) * 100;
    trade('buy', quantity);
  }, [currentBar, portfolio, trade]);

  const selectDrawingMode = useCallback((mode: TrainingDrawingMode) => {
    setDrawingMode((current) => current === mode ? 'none' : mode);
    setDraftPoint(null);
  }, []);

  const handleChartPoint = useCallback((point: TrainingDrawingPoint) => {
    if (drawingMode === 'horizontal') {
      setDrawings((current) => [...current, {
        id: crypto.randomUUID(),
        type: 'horizontal',
        points: [point],
      }]);
      return;
    }
    if (drawingMode !== 'trend') return;
    if (!draftPoint) {
      setDraftPoint(point);
      message.info('已选择趋势线起点，请点击终点');
      return;
    }
    setDrawings((current) => [...current, {
      id: crypto.randomUUID(),
      type: 'trend',
      points: [draftPoint, point],
    }]);
    setDraftPoint(null);
  }, [draftPoint, drawingMode, message]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches('input, textarea, [contenteditable="true"]')) return;
      if (phase !== 'active') return;
      if (event.code === 'Space' || event.key.toLowerCase() === 'n') {
        event.preventDefault();
        nextBar();
      } else if (event.key.toLowerCase() === 'b') {
        trade('buy', lots * 100);
      } else if (event.key.toLowerCase() === 's') {
        trade('sell', lots * 100);
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [lots, nextBar, phase, trade]);

  if (phase === 'idle' || phase === 'loading' || phase === 'error') {
    return <section className="market-sense-page market-sense-welcome" aria-labelledby="market-sense-title" aria-busy={phase === 'loading'}>
      <div className="market-sense-welcome-card">
        <div className="market-sense-welcome-icon"><AimOutlined /></div>
        <Tag className="market-sense-kicker" bordered={false}>A 股 · 日线盲测</Tag>
        <h1 id="market-sense-title">训练你的盘感，而不是记忆答案</h1>
        <p>随机截取一段历史行情，隐藏股票与日期。逐根观察 K 线，在真实 A 股交易约束下完成判断和仓位管理。</p>
        <div className="market-sense-feature-grid">
          <div><EyeInvisibleOutlined /><strong>行情揭盲</strong><span>训练结束后才显示标的与完整走势</span></div>
          <div><SafetyCertificateOutlined /><strong>A 股规则</strong><span>T+1、100 股整手、佣金与印花税</span></div>
          <div><TrophyOutlined /><strong>可复盘</strong><span>收益、回撤、胜率和全部买卖点</span></div>
        </div>
        {phase === 'error' && <div className="market-sense-error" role="alert">{error}</div>}
        <Button
          type="primary"
          size="large"
          icon={phase === 'loading' ? <Spin size="small" /> : <ArrowRightOutlined />}
          loading={phase === 'loading'}
          onClick={() => void startTraining()}
        >
          {phase === 'error' ? '重新尝试' : '开始随机训练'}
        </Button>
        <small>初始资金 100 万元 · 前 80 根 K 线作为判断背景 · 全程仅模拟</small>
      </div>
    </section>;
  }

  return <section className="market-sense-page market-sense-workbench" aria-label="A 股盘感训练台">
    <header className="market-sense-header">
      <div>
        <span className="market-sense-status-dot" />
        <strong>{phase === 'finished' ? '本局复盘' : '盲测进行中'}</strong>
        <Tag bordered={false}>{phase === 'finished' ? `${instrument?.name} ${instrument?.code}` : '标的已隐藏'}</Tag>
      </div>
      <div className="market-sense-progress">
        <span>{phase === 'finished' ? '训练完成' : `${completedSteps} / ${totalSteps}`}</span>
        <Progress percent={phase === 'finished' ? 100 : progress} showInfo={false} strokeColor="#ef4444" trailColor="#202832" />
      </div>
      <Button danger onClick={finishTraining} disabled={phase === 'finished'}>结束训练</Button>
    </header>

    <div className="market-sense-workspace">
      <main className="market-sense-chart-panel">
        <div className="market-sense-chart-toolbar">
          <div className="market-sense-chart-meta">
            <div>
              <span>{phase === 'finished' ? instrument?.market : 'A 股随机样本'}</span>
              <div className="market-sense-meta-primary">
                <strong>{phase === 'finished'
                  ? displayedBar?.date
                  : chartSnapshot && chartSnapshot.index < visibleBars.length - 1
                    ? `第 ${chartSnapshot.index + 1} 根 K 线`
                    : `第 ${completedSteps + 1} 个决策点`}</strong>
                <span className={`market-sense-change ${changeTone}`}>涨跌幅 {changeText}</span>
              </div>
              {displayedBar && <div className="market-sense-hover-stats" aria-label="十字光标行情与指标数据">
                <span>开 <b>{chartNumber(displayedBar.open)}</b></span>
                <span>高 <b>{chartNumber(displayedBar.high)}</b></span>
                <span>低 <b>{chartNumber(displayedBar.low)}</b></span>
                <span>收 <b>{chartNumber(displayedBar.close)}</b></span>
                <span>量 <b>{compactVolume(displayedBar.volume)}</b></span>
                {chartSnapshot && indicators.includes('ma') && <>
                  <span className="ma5">MA5 <b>{chartNumber(chartSnapshot.indicator.ma5)}</b></span>
                  <span className="ma10">MA10 <b>{chartNumber(chartSnapshot.indicator.ma10)}</b></span>
                  <span className="ma20">MA20 <b>{chartNumber(chartSnapshot.indicator.ma20)}</b></span>
                </>}
                {chartSnapshot && indicators.includes('boll') && <>
                  <span className="boll">BOLL上 <b>{chartNumber(chartSnapshot.indicator.bollUpper)}</b></span>
                  <span className="boll-mid">中 <b>{chartNumber(chartSnapshot.indicator.bollMiddle)}</b></span>
                  <span className="boll">下 <b>{chartNumber(chartSnapshot.indicator.bollLower)}</b></span>
                </>}
                {chartSnapshot && indicators.includes('rsi') &&
                  <span className="rsi">RSI14 <b>{chartNumber(chartSnapshot.indicator.rsi14)}</b></span>}
                {chartSnapshot && indicators.includes('macd') && <>
                  <span className="dif">DIF <b>{chartNumber(chartSnapshot.indicator.macdDif, 3)}</b></span>
                  <span className="dea">DEA <b>{chartNumber(chartSnapshot.indicator.macdDea, 3)}</b></span>
                  <span className="macd">MACD <b>{chartNumber(chartSnapshot.indicator.macdHistogram, 3)}</b></span>
                </>}
              </div>}
            </div>
            <div className="market-sense-legend"><span className="up">红涨</span><span className="down">绿跌</span><span>前复权日 K</span></div>
          </div>
          <div className="market-sense-chart-tools" aria-label="图表工具栏">
            <Popover
              placement="bottomLeft"
              trigger="click"
              title="技术指标"
              content={<Checkbox.Group
                value={indicators}
                onChange={(values) => setIndicators(values as TrainingIndicator[])}
                className="market-sense-indicator-picker"
                options={[
                  { label: 'MA 均线', value: 'ma' },
                  { label: 'BOLL 布林带', value: 'boll' },
                  { label: 'RSI14', value: 'rsi' },
                  { label: 'MACD', value: 'macd' },
                ]}
              />}
            >
              <Button icon={<BarChartOutlined />} aria-label="选择技术指标">指标 {indicators.length}</Button>
            </Popover>
            <Tooltip title="恢复浏览模式">
              <Button
                type={drawingMode === 'none' ? 'primary' : 'default'}
                icon={<SelectOutlined />}
                aria-label="浏览模式"
                aria-pressed={drawingMode === 'none'}
                onClick={() => selectDrawingMode('none')}
              />
            </Tooltip>
            <Tooltip title="点击图表绘制水平支撑或压力线">
              <Button
                type={drawingMode === 'horizontal' ? 'primary' : 'default'}
                icon={<MinusOutlined />}
                aria-label="水平线模式"
                aria-pressed={drawingMode === 'horizontal'}
                onClick={() => selectDrawingMode('horizontal')}
              />
            </Tooltip>
            <Tooltip title="依次点击起点和终点绘制趋势线">
              <Button
                type={drawingMode === 'trend' ? 'primary' : 'default'}
                icon={<LineOutlined />}
                aria-label="趋势线模式"
                aria-pressed={drawingMode === 'trend'}
                onClick={() => selectDrawingMode('trend')}
              />
            </Tooltip>
            <Tooltip title="撤销上一条线">
              <Button
                icon={<UndoOutlined />}
                aria-label="撤销上一条线"
                disabled={drawings.length === 0}
                onClick={() => setDrawings((current) => current.slice(0, -1))}
              />
            </Tooltip>
            <Tooltip title="清除全部画线">
              <Button
                icon={<ClearOutlined />}
                aria-label="清除全部画线"
                disabled={drawings.length === 0}
                onClick={() => { setDrawings([]); setDraftPoint(null); }}
              />
            </Tooltip>
            {draftPoint && <span className="market-sense-drawing-hint" role="status">请选择趋势线终点</span>}
          </div>
        </div>
        <TrainingChart
          data={visibleBars}
          trades={portfolio.trades}
          revealTrades={phase === 'finished'}
          theme={isDark ? 'dark' : 'light'}
          indicators={indicators}
          drawingMode={drawingMode}
          drawings={drawings}
          onChartPoint={handleChartPoint}
          onCrosshairChange={setChartSnapshot}
        />
      </main>

      <aside className="market-sense-console" aria-label="交易操作台">
        {phase === 'finished' && summary ? <>
          <div className="market-sense-result-head">
            <CheckCircleOutlined />
            <span>训练完成</span>
            <strong className={summary.totalReturnPct >= 0 ? 'is-profit' : 'is-loss'}>{pct(summary.totalReturnPct)}</strong>
            <small>最终权益 ¥{money(summary.finalEquity)}</small>
            <div className="market-sense-benchmark-return" aria-label={`个股同期涨跌幅 ${pct(stockPeriodReturnPct)}`}>
              <span>个股同期涨跌幅</span>
              <strong className={stockPeriodReturnPct >= 0 ? 'is-profit' : 'is-loss'}>
                {pct(stockPeriodReturnPct)}
              </strong>
            </div>
          </div>
          <div className="market-sense-result-grid">
            <div><span>最大回撤</span><strong className="market-sense-risk-value">{summary.maxDrawdownPct.toFixed(2)}%</strong></div>
            <div><span>已实现盈亏</span><strong>{money(summary.realizedPnl)}</strong></div>
            <div><span>卖出胜率</span><strong>{summary.winRatePct.toFixed(0)}%</strong></div>
            <div><span>操作次数</span><strong>{summary.tradeCount}</strong></div>
          </div>
          <div className="market-sense-review-note">
            <TrophyOutlined />
            <p><strong>复盘提示</strong><span>{summary.tradeCount === 0 ? '本局没有交易，尝试在关键突破或转折处做出明确判断。' : summary.maxDrawdownPct > 10 ? '回撤偏大，下一局优先练习止损和降低单次仓位。' : '仓位风险处于可控范围，结合图中买卖点检查入场是否追高。'}</span></p>
          </div>
          <Button type="primary" size="large" icon={<ReloadOutlined />} onClick={() => void startTraining()}>再来一局</Button>
        </> : <>
          <div className="market-sense-action-row">
            <Button className="market-sense-next" icon={<FastForwardOutlined />} onClick={nextBar}>下一根 <kbd>Space</kbd></Button>
          </div>
          <div className="market-sense-order-row">
            <Button className="market-sense-buy" icon={<ArrowUpOutlined />} onClick={() => trade('buy', lots * 100)}>买入 <kbd>B</kbd></Button>
            <Button className="market-sense-sell" icon={<ArrowDownOutlined />} onClick={() => trade('sell', lots * 100)}>卖出 <kbd>S</kbd></Button>
          </div>
          <div className="market-sense-quantity">
            <label htmlFor="training-lots">交易数量</label>
            <InputNumber id="training-lots" min={1} max={9999} value={lots} onChange={(value) => setLots(Math.max(1, Number(value) || 1))} addonAfter="手" />
            <small>1 手 = 100 股</small>
          </div>
          <div className="market-sense-presets">
            <span>快捷买入</span>
            <Button onClick={() => buyByRatio(.25)}>1/4 可用资金</Button>
            <Button onClick={() => buyByRatio(.5)}>1/2 可用资金</Button>
            <Button onClick={() => buyByRatio(1)}>全部可用资金</Button>
            <Button onClick={() => trade('sell', sellable)} disabled={sellable <= 0}>清空可卖持仓</Button>
          </div>
          <div className="market-sense-holding-line"><span>持仓 {portfolio.quantity.toLocaleString()} 股</span><span>可卖 {sellable.toLocaleString()} 股</span></div>
          <div className="market-sense-position-card">
            <h2>持仓概览</h2>
            <dl>
              <div><dt>持仓成本</dt><dd>{portfolio.quantity > 0 ? `¥${money(portfolio.averageCost)}` : '—'}</dd></div>
              <div><dt>当前价格</dt><dd>¥{money(currentBar?.close ?? 0)}</dd></div>
              <div><dt>浮动盈亏</dt><dd className={unrealizedPnl >= 0 ? 'is-profit' : 'is-loss'}>{money(unrealizedPnl)}</dd></div>
              <div><dt>仓位</dt><dd>{equity > 0 ? `${(portfolio.quantity * (currentBar?.close ?? 0) / equity * 100).toFixed(1)}%` : '0%'}</dd></div>
            </dl>
          </div>
          <div className="market-sense-equity-card">
            <div><span>总权益</span><strong>¥{money(equity)}</strong></div>
            <div><span>可用资金</span><strong>¥{money(portfolio.cash)}</strong></div>
            <div><span>累计收益</span><strong className={equity >= TRAINING_INITIAL_CASH ? 'is-profit' : 'is-loss'}>{pct((equity / TRAINING_INITIAL_CASH - 1) * 100)}</strong></div>
            <div><span>已实现</span><strong className={portfolio.realizedPnl >= 0 ? 'is-profit' : 'is-loss'}>{money(portfolio.realizedPnl)}</strong></div>
          </div>
        </>}
      </aside>
    </div>
  </section>;
}
