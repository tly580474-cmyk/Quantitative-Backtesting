import { useState, useCallback, lazy, Suspense, useMemo, useEffect, useRef } from 'react';
import { HashRouter, Routes, Route, useLocation, useNavigate, useParams } from 'react-router-dom';
import { Checkbox, ConfigProvider, App as AntApp, Button, DatePicker, Dropdown, Modal, Popover, Segmented, Space, Tag } from 'antd';
import type { MenuProps } from 'antd';
import {
  AreaChartOutlined,
  BarChartOutlined,
  ControlOutlined,
  DatabaseOutlined,
  DownOutlined,
  DotChartOutlined,
  DownloadOutlined,
  ExperimentOutlined,
  FundProjectionScreenOutlined,
  LineChartOutlined,
  NodeIndexOutlined,
  ReloadOutlined,
  SettingOutlined,
  StarOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import zhCN from 'antd/locale/zh_CN';
import AppLayout from './components/AppLayout';
import FileUploader from './components/FileUploader';
import StockInfoBar from './components/StockInfoBar';
import ImportResultPanel from './components/ImportResultPanel';
import IndicatorPanel from './components/IndicatorPanel';
import PageSkeleton from './components/PageSkeleton';
import { WorkbenchDrawer, WorkbenchPanel } from './components/WorkbenchPanel';
import RangeChangePanel from './features/chart/RangeChangePanel';
import SaveDatasetModal from './features/dataLibrary/SaveDatasetModal';
import { useImport } from './features/import/useImport';
import { useCandleStore } from './stores/useCandleStore';
import { apiFetch } from '@/api/client';
import { getRepository } from './api/useRepository';
import { computeChecksum } from './db/marketDataRepository';
import type { ImportResult } from './models';
import {
  aggregateCandles,
  isMinutePeriod,
  minutePeriodValue,
  type ChartPeriod,
  type MinuteChartPeriod,
} from './features/chart/timeframe';
import { analyzeChanlun } from './features/chanlun';
import ChanStructurePanel from './features/chanlun/ChanStructurePanel';
import {
  fetchAdjustedDatasets,
  fetchAdjustedDatasetsByCode,
  exportAdjustedKlinesToExcel,
  resolveInstrumentBySymbol,
} from './features/marketData/exportMarketData';

const ChartContainer = lazy(() => import('./features/chart/ChartContainer'));
const DataLibrary = lazy(() => import('./features/dataLibrary/DataLibrary'));
const BacktestRunner = lazy(() => import('./features/backtest/BacktestRunner'));
const BacktestResultsPage = lazy(() => import('./features/backtestResults/BacktestResultsPage'));
const StrategyStudioPage = lazy(() => import('./features/strategyStudio/StrategyStudioPage'));
const MarketDataPage = lazy(() => import('./features/marketData/MarketDataPage'));
const FactorResearchPage = lazy(() => import('./features/factorResearch/FactorResearchPage'));

interface MinuteCatalogResponse {
  status: 'ready' | 'unavailable';
  firstDate?: string | null;
  lastDate?: string | null;
}

interface MinuteBarsResponse {
  intervalMinutes: number;
  sourceFiles: number;
  truncated: boolean;
  elapsedMs: number;
  items: Array<{
    date: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    amount: number;
  }>;
}

const MINUTE_DEFAULT_WINDOW_DAYS: Record<MinuteChartPeriod, number> = {
  minute1: 5,
  minute5: 15,
  minute15: 30,
  minute30: 60,
  minute60: 90,
  minute120: 120,
};

const MINUTE_MAX_WINDOW_DAYS: Record<MinuteChartPeriod, number> = {
  minute1: 15,
  minute5: 60,
  minute15: 120,
  minute30: 180,
  minute60: 366,
  minute120: 366,
};

function normalizeMinuteTime(value: string): string {
  return value.trim().replace('T', ' ').slice(0, 16);
}

const COMMON_PERIOD_OPTIONS: Array<{ label: string; value: ChartPeriod }> = [
  { label: '1分', value: 'minute1' },
  { label: '5分', value: 'minute5' },
  { label: '日K', value: 'day' },
  { label: '周K', value: 'week' },
  { label: '月K', value: 'month' },
];

const MORE_PERIOD_OPTIONS: Array<{ label: string; value: ChartPeriod }> = [
  { label: '15分钟', value: 'minute15' },
  { label: '30分钟', value: 'minute30' },
  { label: '60分钟', value: 'minute60' },
  { label: '120分钟', value: 'minute120' },
  { label: '季K', value: 'quarter' },
  { label: '年K', value: 'year' },
];

const NAV_ITEMS: MenuProps['items'] = [
  {
    type: 'group',
    label: '数据中心',
    children: [
      { key: '/market-data', icon: <DatabaseOutlined />, label: '市场数据' },
      { key: '/watchlist', icon: <StarOutlined />, label: '我的自选' },
      { key: '/data', icon: <ControlOutlined />, label: '数据管理' },
    ],
  },
  {
    type: 'group',
    label: '研究分析',
    children: [
      { key: '/analysis', icon: <LineChartOutlined />, label: '行情分析' },
      { key: '/factors', icon: <DotChartOutlined />, label: '因子研究' },
    ],
  },
  {
    type: 'group',
    label: '策略研发',
    children: [
      { key: '/studio', icon: <FundProjectionScreenOutlined />, label: '策略工作室' },
    ],
  },
  {
    type: 'group',
    label: '回测实验',
    children: [
      { key: '/backtest', icon: <ExperimentOutlined />, label: '策略回测' },
    ],
  },
  {
    type: 'group',
    label: '结果复盘',
    children: [
      { key: '/results', icon: <AreaChartOutlined />, label: '回测结果' },
    ],
  },
];

const PAGE_LABELS: Record<string, string> = {
  '/market-data': '市场数据',
  '/watchlist': '我的自选',
  '/analysis': '行情分析',
  '/data': '数据管理',
  '/backtest': '策略回测',
  '/results': '回测结果',
  '/factors': '因子研究',
  '/studio': '策略工作室',
};

function DataLibraryRoute() {
  const navigate = useNavigate();
  return <DataLibrary onOpen={() => navigate('/analysis')} />;
}

function useCompactViewport() {
  const [matches, setMatches] = useState(() => (
    typeof window !== 'undefined'
      ? window.matchMedia('(max-width: 991px)').matches
      : false
  ));

  useEffect(() => {
    const media = window.matchMedia('(max-width: 991px)');
    const handleChange = () => setMatches(media.matches);
    handleChange();
    media.addEventListener('change', handleChange);
    return () => media.removeEventListener('change', handleChange);
  }, []);

  return matches;
}

function MarketAnalysisRoute() {
  const navigate = useNavigate();
  const { notification } = AntApp.useApp();
  const [rangeSelectionEnabled, setRangeSelectionEnabled] = useState(false);
  const [period, setPeriod] = useState<ChartPeriod>('day');
  const [showChipProfile, setShowChipProfile] = useState(false);
  const [chanEnabled, setChanEnabled] = useState(false);
  const [showChanPens, setShowChanPens] = useState(true);
  const [showChanFractals, setShowChanFractals] = useState(true);
  const [showChanSegments, setShowChanSegments] = useState(true);
  const [showChanPenCenters, setShowChanPenCenters] = useState(true);
  const [showChanSegmentCenters, setShowChanSegmentCenters] = useState(true);
  const [indicatorInspectorOpen, setIndicatorInspectorOpen] = useState(true);
  const [indicatorDrawerOpen, setIndicatorDrawerOpen] = useState(false);
  const [inspectorMode, setInspectorMode] = useState<'indicator' | 'chan'>('indicator');
  const [exportingAnalysis, setExportingAnalysis] = useState(false);
  const [minuteCandles, setMinuteCandles] = useState<ImportResult['candles']>([]);
  const [minuteRange, setMinuteRange] = useState<[string, string] | null>(null);
  const [minuteCatalog, setMinuteCatalog] = useState<MinuteCatalogResponse | null>(null);
  const [minuteLoading, setMinuteLoading] = useState(false);
  const [minuteMeta, setMinuteMeta] = useState<{ sourceFiles: number; elapsedMs: number; truncated: boolean } | null>(null);
  const minuteRequestRef = useRef(0);
  const emptyCandlesPromptShownRef = useRef(false);
  const isCompactViewport = useCompactViewport();
  const sourceCandles = useCandleStore((state) => state.candles);
  const importResult = useCandleStore((state) => state.importResult);
  const analysisSymbol = importResult?.symbol ?? sourceCandles[0]?.symbol ?? '';
  const activeSourceCandles = isMinutePeriod(period) ? minuteCandles : sourceCandles;
  const displayCandles = useMemo(
    () => aggregateCandles(activeSourceCandles, period),
    [activeSourceCandles, period],
  );
  const chanAnalysis = useMemo(() => analyzeChanlun(displayCandles), [displayCandles]);

  const loadMinuteCandles = useCallback(async (
    nextPeriod: MinuteChartPeriod,
    range: [string, string],
    quiet = false,
  ) => {
    if (!analysisSymbol) {
      if (!quiet) notification.warning({ message: '请先从市场数据或数据管理打开一只股票' });
      return;
    }
    const maxDays = MINUTE_MAX_WINDOW_DAYS[nextPeriod];
    if (dayjs(range[1]).diff(dayjs(range[0]), 'day') + 1 > maxDays) {
      notification.warning({ message: `${minutePeriodValue(nextPeriod)} 分钟线单次最多加载 ${maxDays} 个自然日` });
      return;
    }
    const requestId = ++minuteRequestRef.current;
    setMinuteLoading(true);
    try {
      const query = new URLSearchParams({
        startDate: range[0],
        endDate: range[1],
        interval: String(minutePeriodValue(nextPeriod)),
        includeZeroVolume: 'true',
        limit: '100000',
      });
      const response = await apiFetch<MinuteBarsResponse>(
        `/api/market-data/stocks/${encodeURIComponent(analysisSymbol)}/minute?${query}`,
        { timeoutMs: 60000 },
      );
      if (requestId !== minuteRequestRef.current) return;
      const requestedInterval = minutePeriodValue(nextPeriod);
      if (response.intervalMinutes !== requestedInterval) {
        throw new Error(`分钟周期校验失败：请求 ${requestedInterval} 分钟，服务端返回 ${response.intervalMinutes ?? '未知'} 分钟；请重启后端服务`);
      }
      setMinuteCandles(response.items.map((item) => ({
        time: normalizeMinuteTime(item.date),
        symbol: analysisSymbol,
        open: item.open,
        high: item.high,
        low: item.low,
        close: item.close,
        volume: item.volume,
        turnover: item.amount / 100_000_000,
      })));
      setMinuteMeta({
        sourceFiles: response.sourceFiles,
        elapsedMs: response.elapsedMs,
        truncated: response.truncated,
      });
      if (response.truncated) notification.warning({ message: '分钟数据达到返回上限，请缩短日期范围' });
    } catch (error) {
      if (requestId !== minuteRequestRef.current) return;
      setMinuteCandles([]);
      setMinuteMeta(null);
      notification.error({ message: error instanceof Error ? error.message : '分钟行情加载失败' });
    } finally {
      if (requestId === minuteRequestRef.current) setMinuteLoading(false);
    }
  }, [analysisSymbol, notification]);

  useEffect(() => {
    if (!isMinutePeriod(period)) return;
    let cancelled = false;
    const prepare = async () => {
      try {
        const catalog = await apiFetch<MinuteCatalogResponse>('/api/market-data/minute/catalog');
        if (cancelled) return;
        setMinuteCatalog(catalog);
        if (catalog.status !== 'ready' || !catalog.lastDate) {
          setMinuteCandles([]);
          notification.warning({ message: 'DuckDB 分钟快照暂不可用' });
          return;
        }
        const end = catalog.lastDate;
        const start = dayjs(end).subtract(MINUTE_DEFAULT_WINDOW_DAYS[period] - 1, 'day').format('YYYY-MM-DD');
        const range: [string, string] = [start, end];
        setMinuteRange(range);
        await loadMinuteCandles(period, range, true);
      } catch (error) {
        if (!cancelled) notification.error({ message: error instanceof Error ? error.message : '分钟数据目录读取失败' });
      }
    };
    void prepare();
    return () => { cancelled = true; };
  }, [loadMinuteCandles, notification, period]);

  useEffect(() => {
    if (sourceCandles.length > 0) {
      emptyCandlesPromptShownRef.current = false;
      notification.destroy('empty-analysis-candles');
      return undefined;
    }

    if (emptyCandlesPromptShownRef.current) return undefined;
    emptyCandlesPromptShownRef.current = true;
    notification.info({
      key: 'empty-analysis-candles',
      title: '当前没有可展示的 K 线数据',
      description: '可在数据管理中导入 Excel / CSV，或打开已有数据集后再查看图表。',
      placement: 'topRight',
      duration: 8,
      actions: (
        <Button
          type="primary"
          size="small"
          onClick={() => {
            notification.destroy('empty-analysis-candles');
            navigate('/data');
          }}
        >
          去数据管理
        </Button>
      ),
    });
    return undefined;
  }, [navigate, notification, sourceCandles.length]);

  const handleInspectorToggle = useCallback((mode: 'indicator' | 'chan') => {
    setInspectorMode(mode);
    if (isCompactViewport) {
      setIndicatorDrawerOpen(true);
      return;
    }
    setIndicatorInspectorOpen((value) => inspectorMode === mode ? !value : true);
  }, [inspectorMode, isCompactViewport]);

  const handleExportAnalysis = useCallback(async () => {
    const { importResult } = useCandleStore.getState();
    const symbol = importResult?.symbol ?? sourceCandles[0]?.symbol;
    if (!symbol) {
      notification.warning({ message: '当前没有可导出的标的' });
      return;
    }
    setExportingAnalysis(true);
    try {
      let instrumentId = importResult?.instrumentId ?? null;
      let resolvedName = importResult?.name;
      if (!instrumentId) {
        const resolved = await resolveInstrumentBySymbol(symbol);
        if (resolved) {
          instrumentId = resolved.id;
          resolvedName = resolvedName ?? resolved.name;
        }
      }
      let datasets = instrumentId
        ? await fetchAdjustedDatasets(instrumentId, symbol)
        : null;
      if (!datasets || (!datasets.raw?.length && !datasets.qfq?.length && !datasets.hfq?.length)) {
        // 未接入行情数据库时，改为通过个股代码接口按三种复权口径拉取。
        datasets = await fetchAdjustedDatasetsByCode(symbol);
      }
      if (!datasets || (!datasets.raw?.length && !datasets.qfq?.length && !datasets.hfq?.length)) {
        // 兜底：直接导出当前图表已加载的 K 线（单一复权口径）。
        if (sourceCandles.length === 0) throw new Error('未获取到任何行情数据');
        const points = sourceCandles.map((candle) => ({
          date: candle.time,
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
          volume: candle.volume ?? 0,
          turnoverRatePct: candle.turnoverRatePct,
        }));
        const fallbackName = resolvedName ?? symbol;
        const fileName = exportAdjustedKlinesToExcel(
          { code: symbol, name: fallbackName },
          { raw: points, qfq: null, hfq: null },
        );
        notification.success({ message: `已导出当前行情（单一口径） ${fileName}` });
        return;
      }
      const fileName = exportAdjustedKlinesToExcel(
        { code: symbol, name: resolvedName ?? symbol },
        datasets,
      );
      notification.success({ message: `已导出 ${fileName}` });
    } catch (error) {
      notification.error({ message: error instanceof Error ? error.message : '导出失败' });
    } finally {
      setExportingAnalysis(false);
    }
  }, [notification, sourceCandles]);

  const inspectorContent = (
    <>
      <Segmented
        block
        size="small"
        value={inspectorMode}
        options={[
          { label: '指标', value: 'indicator' },
          { label: '缠论', value: 'chan' },
        ]}
        onChange={setInspectorMode}
      />
      {inspectorMode === 'indicator'
        ? <IndicatorPanel />
        : <ChanStructurePanel analysis={chanAnalysis} />}
    </>
  );

  const indicatorPanel = (
    <WorkbenchPanel
      title="分析图层"
      subtitle={inspectorMode === 'indicator' ? '技术指标与参数' : '当前结构与确认依据'}
      className="market-analysis-inspector-panel"
      closeLabel="收起分析图层"
      onClose={!isCompactViewport ? () => setIndicatorInspectorOpen(false) : undefined}
    >
      {inspectorContent}
    </WorkbenchPanel>
  );

  const chanLayerOptions = (
    <div className="market-layer-options analysis-chan-layer-options" aria-label="缠线图层选择">
      <Checkbox
        checked={chanEnabled}
        disabled={displayCandles.length === 0}
        onChange={(event) => setChanEnabled(event.target.checked)}
      >
        启用缠线分析
      </Checkbox>
      <div className="market-layer-options-divider" />
      <Checkbox
        checked={showChanFractals}
        disabled={!chanEnabled}
        onChange={(event) => setShowChanFractals(event.target.checked)}
      >
        顶底分型
      </Checkbox>
      <Checkbox
        checked={showChanPens}
        disabled={!chanEnabled}
        onChange={(event) => setShowChanPens(event.target.checked)}
      >
        笔
      </Checkbox>
      <Checkbox
        checked={showChanSegments}
        disabled={!chanEnabled}
        onChange={(event) => setShowChanSegments(event.target.checked)}
      >
        线段
      </Checkbox>
      <Checkbox
        checked={showChanPenCenters}
        disabled={!chanEnabled}
        onChange={(event) => setShowChanPenCenters(event.target.checked)}
      >
        笔中枢
      </Checkbox>
      <Checkbox
        checked={showChanSegmentCenters}
        disabled={!chanEnabled}
        onChange={(event) => setShowChanSegmentCenters(event.target.checked)}
      >
        段中枢
      </Checkbox>
      <span className="analysis-chan-layer-note">候选结构与确认结构沿用 chan-v1 规则。</span>
    </div>
  );

  const morePeriod = MORE_PERIOD_OPTIONS.find((option) => option.value === period);

  const analysisControls = (
    <Space className="market-analysis-toolbar-controls" size={8} wrap>
      <Button
        type={!isCompactViewport && indicatorInspectorOpen && inspectorMode === 'indicator' ? 'primary' : 'default'}
        size="small"
        icon={<SettingOutlined />}
        aria-pressed={!isCompactViewport && indicatorInspectorOpen && inspectorMode === 'indicator'}
        onClick={() => handleInspectorToggle('indicator')}
      >
        指标
      </Button>
      <Button
        type={!isCompactViewport && indicatorInspectorOpen && inspectorMode === 'chan' ? 'primary' : 'default'}
        size="small"
        icon={<NodeIndexOutlined />}
        aria-pressed={!isCompactViewport && indicatorInspectorOpen && inspectorMode === 'chan'}
        onClick={() => handleInspectorToggle('chan')}
      >
        缠论
      </Button>
      <Popover placement="bottomRight" trigger="click" title="缠线图层" content={chanLayerOptions}>
        <Button
          type={chanEnabled ? 'primary' : 'default'}
          size="small"
          icon={<NodeIndexOutlined />}
          aria-pressed={chanEnabled}
          disabled={displayCandles.length === 0}
          title="配置缠线图层"
        >
          缠线
        </Button>
      </Popover>
      <Button
        className="market-chip-toggle"
        type={showChipProfile && period === 'day' ? 'primary' : 'default'}
        size="small"
        icon={<BarChartOutlined />}
        aria-pressed={showChipProfile && period === 'day'}
        disabled={period !== 'day' || sourceCandles.length === 0}
        title={period === 'day' ? '在主图右侧显示筹码峰' : '筹码峰仅支持日 K'}
        onClick={() => setShowChipProfile((value) => !value)}
      >
        筹码峰
      </Button>
      {chanEnabled && <Tag className="chan-version-tag" variant="filled">chan-v1</Tag>}
      <div className="analysis-period-switcher" aria-label="K线周期">
        <Segmented<ChartPeriod>
          size="small"
          value={(COMMON_PERIOD_OPTIONS.some((option) => option.value === period) ? period : '') as ChartPeriod}
          options={COMMON_PERIOD_OPTIONS}
          onChange={setPeriod}
        />
        <Dropdown
          trigger={['click']}
          placement="bottomRight"
          menu={{
            selectable: true,
            selectedKeys: morePeriod ? [morePeriod.value] : [],
            items: MORE_PERIOD_OPTIONS.map((option) => ({ key: option.value, label: option.label })),
            onClick: ({ key }) => setPeriod(key as ChartPeriod),
          }}
        >
          <Button
            className="analysis-more-period"
            type={morePeriod ? 'primary' : 'text'}
            size="small"
          >
            {morePeriod?.label ?? '更多'} <DownOutlined />
          </Button>
        </Dropdown>
      </div>
      {isMinutePeriod(period) && (
        <Space.Compact className="analysis-minute-range">
          <DatePicker.RangePicker
            size="small"
            allowClear={false}
            value={minuteRange ? [dayjs(minuteRange[0]), dayjs(minuteRange[1])] : null}
            minDate={minuteCatalog?.firstDate ? dayjs(minuteCatalog.firstDate) : undefined}
            maxDate={minuteCatalog?.lastDate ? dayjs(minuteCatalog.lastDate) : undefined}
            onChange={(dates) => {
              if (dates?.[0] && dates[1]) {
                setMinuteRange([dates[0].format('YYYY-MM-DD'), dates[1].format('YYYY-MM-DD')]);
              }
            }}
          />
          <Button
            size="small"
            icon={<ReloadOutlined />}
            loading={minuteLoading}
            disabled={!minuteRange || !analysisSymbol}
            onClick={() => minuteRange && loadMinuteCandles(period, minuteRange)}
          >
            加载
          </Button>
        </Space.Compact>
      )}
      {isMinutePeriod(period) && minuteMeta && (
        <Tag className="analysis-minute-source" color={minuteMeta.truncated ? 'warning' : 'blue'}>
          DuckDB · {minuteMeta.sourceFiles} 日 · {displayCandles.length} 根 · {minuteMeta.elapsedMs}ms
        </Tag>
      )}
      <Button
        size="small"
        icon={<DownloadOutlined />}
        loading={exportingAnalysis}
        disabled={sourceCandles.length === 0 || isMinutePeriod(period)}
        title={isMinutePeriod(period) ? '分钟行情按需加载，不参与日 K 复权导出' : '导出前复权 / 后复权 / 不复权日 K 行情'}
        onClick={handleExportAnalysis}
      >
        导出数据
      </Button>
    </Space>
  );

  return (
    <div className="market-analysis-page">
      {displayCandles.length === 0 && (
        <div className="market-analysis-toolbar is-empty">
          <div className="market-analysis-toolbar-extra">{analysisControls}</div>
        </div>
      )}
      <RangeChangePanel
        enabled={rangeSelectionEnabled}
        onEnabledChange={setRangeSelectionEnabled}
        candles={displayCandles}
        extra={analysisControls}
      />
      <div className={indicatorInspectorOpen ? 'market-analysis-workspace has-inspector' : 'market-analysis-workspace'}>
        <div className="market-analysis-chart">
          <ChartContainer
            sourceCandles={activeSourceCandles}
            showRangeLines={rangeSelectionEnabled}
            period={period}
            showChipProfile={showChipProfile && period === 'day'}
            showChanPens={chanEnabled && showChanPens}
            showChanFractals={chanEnabled && showChanFractals}
            showChanSegments={chanEnabled && showChanSegments}
            showChanPenCenters={chanEnabled && showChanPenCenters}
            showChanSegmentCenters={chanEnabled && showChanSegmentCenters}
          />
        </div>
        {indicatorInspectorOpen && (
          <aside className="market-analysis-inspector">
            {indicatorPanel}
          </aside>
        )}
      </div>
      <WorkbenchDrawer
        className="market-analysis-indicator-drawer"
        title="分析图层"
        open={indicatorDrawerOpen}
        onClose={() => setIndicatorDrawerOpen(false)}
      >
        {inspectorContent}
      </WorkbenchDrawer>
    </div>
  );
}

function MarketDataRoute() {
  const navigate = useNavigate();
  const handleOpenInAnalysis = useCallback((result: ImportResult) => {
    useCandleStore.getState().setCandles(result.candles);
    useCandleStore.getState().setImportResult(result);
    navigate('/analysis');
  }, [navigate]);

  return <MarketDataPage view="overview" onOpenInAnalysis={handleOpenInAnalysis} onOpenDetail={(stock) => navigate(`/market-detail/${stock.code}`)} />;
}

function WatchlistRoute() {
  const navigate = useNavigate();
  const handleOpenInAnalysis = useCallback((result: ImportResult) => {
    useCandleStore.getState().setCandles(result.candles);
    useCandleStore.getState().setImportResult(result);
    navigate('/analysis');
  }, [navigate]);

  return <MarketDataPage view="watchlist" onOpenInAnalysis={handleOpenInAnalysis} />;
}

function MarketDetailRoute() {
  const navigate = useNavigate();
  const { code = '' } = useParams();
  const handleOpenInAnalysis = useCallback((result: ImportResult) => {
    useCandleStore.getState().setCandles(result.candles);
    useCandleStore.getState().setImportResult(result);
    navigate('/analysis');
  }, [navigate]);

  return <MarketDataPage view="detail" instrumentCode={code} onOpenInAnalysis={handleOpenInAnalysis} />;
}

function AppContent() {
  const { importFile, importFiles, loading } = useImport();
  const importResult = useCandleStore((state) => state.importResult);
  const [alertResult, setAlertResult] = useState<ImportResult | null>(null);
  const [saveModalOpen, setSaveModalOpen] = useState(false);
  const [batchSummary, setBatchSummary] = useState<string[] | null>(null);
  const location = useLocation();
  const navigate = useNavigate();
  const activeKey = location.pathname === '/'
    ? '/market-data'
    : location.pathname.startsWith('/') ? location.pathname : '/market-data';

  const handleImport = useCallback(async (files: File[]) => {
    const results = files.length === 1
      ? [await importFile(files[0])]
      : await importFiles(files);
    const result = [...results].reverse().find((item) => item.success)
      ?? results[results.length - 1];
    if (result) {
      useCandleStore.getState().setCandles(result.candles);
      useCandleStore.getState().setImportResult(result);
      navigate('/analysis');
      if (result.errors.length > 0 || result.warnings.length > 0) {
        setAlertResult(result);
      }
    }

    if (files.length > 1) {
      let saved = 0;
      let skipped = 0;
      let failed = 0;
      for (const item of results) {
        if (!item.success) {
          failed++;
          continue;
        }
        const checksum = computeChecksum(item.candles);
        if (await getRepository().findDuplicateByChecksum(checksum)) {
          skipped++;
          continue;
        }
        const now = new Date().toISOString();
        const baseName = item.fileName.replace(/\.(?:xlsx|xls|csv)$/i, '');
        await getRepository().saveDataset({
          id: crypto.randomUUID(),
          name: item.symbol || baseName,
          symbol: item.symbol || baseName,
          timeframe: '1d',
          startTime: item.dateRange.from,
          endTime: item.dateRange.to,
          count: item.validRows,
          sourceFileName: item.fileName,
          checksum,
          createdAt: now,
          updatedAt: now,
        }, item.candles);
        saved++;
      }
      setBatchSummary([
        `成功保存 ${saved} 个数据集`,
        `跳过 ${skipped} 个重复数据集`,
        `失败 ${failed} 个文件`,
      ]);
    }
  }, [importFile, importFiles, navigate]);

  const handleSaveToDb = useCallback(() => {
    setSaveModalOpen(true);
  }, []);

  const topBar = (
    <>
      <FileUploader onImport={handleImport} loading={loading} />
      {importResult && (
        <StockInfoBar
          result={importResult}
          onSaveToDb={handleSaveToDb}
          showAdjustmentControl={activeKey === '/analysis'}
        />
      )}
    </>
  );

  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: {
          colorPrimary: '#1677FF',
          borderRadius: 6,
        },
      }}
    >
      <AntApp>
        <AppLayout
          activeKey={activeKey}
          activeTitle={location.pathname.startsWith('/market-detail/') ? '行情详情' : PAGE_LABELS[activeKey] ?? '市场数据'}
          navigationItems={NAV_ITEMS}
          onNavigate={(key) => navigate(key)}
          onBack={location.pathname.startsWith('/market-detail/') ? () => navigate('/market-data') : undefined}
          topBar={topBar}
          center={
            <Suspense fallback={<PageSkeleton />}>
              <Routes>
                <Route path="/" element={<MarketDataRoute />} />
                <Route path="/analysis" element={<MarketAnalysisRoute />} />
                <Route path="/data" element={<DataLibraryRoute />} />
                <Route path="/market-data" element={<MarketDataRoute />} />
                <Route path="/market-detail/:code" element={<MarketDetailRoute />} />
                <Route path="/watchlist" element={<WatchlistRoute />} />
                <Route path="/backtest" element={<BacktestRunner />} />
                <Route path="/results" element={<BacktestResultsPage />} />
                <Route path="/factors" element={<FactorResearchPage />} />
                <Route path="/studio" element={<StrategyStudioPage />} />
              </Routes>
            </Suspense>
          }
        />
        <Modal
          title="导入结果"
          open={alertResult !== null}
          onCancel={() => setAlertResult(null)}
          footer={null}
          width={520}
          destroyOnHidden
        >
          {alertResult && <ImportResultPanel result={alertResult} />}
        </Modal>
        <SaveDatasetModal
          open={saveModalOpen}
          onClose={() => setSaveModalOpen(false)}
        />
        <Modal
          title="批量导入完成"
          open={batchSummary !== null}
          onOk={() => setBatchSummary(null)}
          onCancel={() => setBatchSummary(null)}
          cancelButtonProps={{ style: { display: 'none' } }}
        >
          {batchSummary?.map((line) => <p key={line}>{line}</p>)}
        </Modal>
      </AntApp>
    </ConfigProvider>
  );
}

export default function App() {
  return (
    <HashRouter>
      <AppContent />
    </HashRouter>
  );
}
