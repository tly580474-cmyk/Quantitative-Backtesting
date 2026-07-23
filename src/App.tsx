import { useState, useCallback, lazy, Suspense, useMemo, useEffect, useRef } from 'react';
import { HashRouter, Routes, Route, useLocation, useNavigate, useParams } from 'react-router-dom';
import { ConfigProvider, App as AntApp, Button, Modal, Segmented, Space, Tag } from 'antd';
import type { MenuProps } from 'antd';
import {
  AreaChartOutlined,
  BarChartOutlined,
  ControlOutlined,
  DatabaseOutlined,
  DotChartOutlined,
  DownloadOutlined,
  ExperimentOutlined,
  FundProjectionScreenOutlined,
  LineChartOutlined,
  NodeIndexOutlined,
  SettingOutlined,
  StarOutlined,
} from '@ant-design/icons';
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
import { aggregateCandles, type ChartPeriod } from './features/chart/timeframe';
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
  const [showChanPens, setShowChanPens] = useState(true);
  const [showChanFractals, setShowChanFractals] = useState(true);
  const [showChanSegments, setShowChanSegments] = useState(true);
  const [showChanPenCenters, setShowChanPenCenters] = useState(true);
  const [showChanSegmentCenters, setShowChanSegmentCenters] = useState(true);
  const [indicatorInspectorOpen, setIndicatorInspectorOpen] = useState(true);
  const [indicatorDrawerOpen, setIndicatorDrawerOpen] = useState(false);
  const [inspectorMode, setInspectorMode] = useState<'indicator' | 'chan'>('indicator');
  const [exportingAnalysis, setExportingAnalysis] = useState(false);
  const emptyCandlesPromptShownRef = useRef(false);
  const isCompactViewport = useCompactViewport();
  const sourceCandles = useCandleStore((state) => state.candles);
  const displayCandles = useMemo(
    () => aggregateCandles(sourceCandles, period),
    [period, sourceCandles],
  );
  const chanAnalysis = useMemo(() => analyzeChanlun(displayCandles), [displayCandles]);

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
      <Space.Compact className="chan-layer-controls">
        <Button
          type={showChanPens ? 'primary' : 'default'}
          size="small"
          icon={<NodeIndexOutlined />}
          aria-pressed={showChanPens}
          disabled={displayCandles.length === 0}
          title="显示或隐藏缠论笔；紫色实线为确认笔，橙色虚线为候选笔"
          onClick={() => setShowChanPens((value) => !value)}
        >
          缠论笔
        </Button>
        <Button
          type={showChanFractals ? 'primary' : 'default'}
          size="small"
          aria-pressed={showChanFractals}
          disabled={displayCandles.length === 0}
          title="显示或隐藏严格顶底分型"
          onClick={() => setShowChanFractals((value) => !value)}
        >
          分型
        </Button>
        <Button
          type={showChanSegments ? 'primary' : 'default'}
          size="small"
          aria-pressed={showChanSegments}
          disabled={displayCandles.length === 0}
          title="显示或隐藏标准特征序列线段"
          onClick={() => setShowChanSegments((value) => !value)}
        >
          线段
        </Button>
        <Button
          type={showChanPenCenters ? 'primary' : 'default'}
          size="small"
          aria-pressed={showChanPenCenters}
          disabled={displayCandles.length === 0}
          title="显示或隐藏笔级别标准中枢"
          onClick={() => setShowChanPenCenters((value) => !value)}
        >
          笔中枢
        </Button>
        <Button
          type={showChanSegmentCenters ? 'primary' : 'default'}
          size="small"
          aria-pressed={showChanSegmentCenters}
          disabled={displayCandles.length === 0}
          title="显示或隐藏线段级别标准中枢"
          onClick={() => setShowChanSegmentCenters((value) => !value)}
        >
          段中枢
        </Button>
      </Space.Compact>
      <Tag className="chan-version-tag" variant="filled">chan-v1</Tag>
      <Segmented<ChartPeriod>
        aria-label="K线周期"
        size="small"
        value={period}
        options={[
          { label: '日K', value: 'day' },
          { label: '周K', value: 'week' },
          { label: '月K', value: 'month' },
        ]}
        onChange={setPeriod}
      />
      <Button
        size="small"
        icon={<DownloadOutlined />}
        loading={exportingAnalysis}
        disabled={sourceCandles.length === 0}
        title="导出前复权 / 后复权 / 不复权日 K 行情"
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
            showRangeLines={rangeSelectionEnabled}
            period={period}
            showChipProfile={showChipProfile && period === 'day'}
            showChanPens={showChanPens}
            showChanFractals={showChanFractals}
            showChanSegments={showChanSegments}
            showChanPenCenters={showChanPenCenters}
            showChanSegmentCenters={showChanSegmentCenters}
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
