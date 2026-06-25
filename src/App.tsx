import { useState, useCallback, lazy, Suspense } from 'react';
import { HashRouter, Routes, Route, useLocation, useNavigate } from 'react-router-dom';
import { ConfigProvider, App as AntApp, Modal, Tabs } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import AppLayout from './components/AppLayout';
import FileUploader from './components/FileUploader';
import StockInfoBar from './components/StockInfoBar';
import ImportResultPanel from './components/ImportResultPanel';
import IndicatorPanel from './components/IndicatorPanel';
import PageSkeleton from './components/PageSkeleton';
import RangeChangePanel from './features/chart/RangeChangePanel';
import SaveDatasetModal from './features/dataLibrary/SaveDatasetModal';
import { useImport } from './features/import/useImport';
import { useCandleStore } from './stores/useCandleStore';
import { getRepository } from './api/useRepository';
import { computeChecksum } from './db/marketDataRepository';
import type { ImportResult } from './models';

const ChartContainer = lazy(() => import('./features/chart/ChartContainer'));
const DataLibrary = lazy(() => import('./features/dataLibrary/DataLibrary'));
const BacktestRunner = lazy(() => import('./features/backtest/BacktestRunner'));
const BacktestResultsPage = lazy(() => import('./features/backtestResults/BacktestResultsPage'));
const StrategyStudioPage = lazy(() => import('./features/strategyStudio/StrategyStudioPage'));
const MarketDataPage = lazy(() => import('./features/marketData/MarketDataPage'));

const TAB_ITEMS = [
  { key: '/market-data', label: '市场数据' },
  { key: '/analysis', label: '行情分析' },
  { key: '/data', label: '数据管理' },
  { key: '/backtest', label: '策略回测' },
  { key: '/results', label: '回测结果' },
  { key: '/studio', label: '策略工作室' },
];

function DataLibraryRoute() {
  const navigate = useNavigate();
  return <DataLibrary onOpen={() => navigate('/analysis')} />;
}

function MarketAnalysisRoute() {
  const [rangeSelectionEnabled, setRangeSelectionEnabled] = useState(true);

  return (
    <>
      <RangeChangePanel
        enabled={rangeSelectionEnabled}
        onEnabledChange={setRangeSelectionEnabled}
      />
      <ChartContainer
        key={rangeSelectionEnabled ? 'range-selection-on' : 'range-selection-off'}
        showRangeLines={rangeSelectionEnabled}
      />
    </>
  );
}

function MarketDataRoute() {
  const navigate = useNavigate();
  const handleOpenInAnalysis = useCallback((result: ImportResult) => {
    useCandleStore.getState().setCandles(result.candles);
    useCandleStore.getState().setImportResult(result);
    navigate('/analysis');
  }, [navigate]);

  return <MarketDataPage onOpenInAnalysis={handleOpenInAnalysis} />;
}

function AppContent() {
  const { importFile, importFiles, loading } = useImport();
  const importResult = useCandleStore((state) => state.importResult);
  const [alertResult, setAlertResult] = useState<ImportResult | null>(null);
  const [saveModalOpen, setSaveModalOpen] = useState(false);
  const [batchSummary, setBatchSummary] = useState<string[] | null>(null);
  const location = useLocation();
  const navigate = useNavigate();

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
        const baseName = item.fileName.replace(/\.xlsx$/i, '');
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
        />
      )}
    </>
  );

  const activeKey = location.pathname === '/' ? '/market-data' : location.pathname.startsWith('/') ? location.pathname : '/market-data';

  const tabBar = (
    <Tabs
      activeKey={activeKey}
      onChange={(key) => navigate(key)}
      items={TAB_ITEMS}
    />
  );

  const leftPanel = activeKey === '/analysis' ? <IndicatorPanel /> : undefined;

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
          topBar={topBar}
          tabBar={tabBar}
          leftPanel={leftPanel}
          center={
            <Suspense fallback={<PageSkeleton />}>
              <Routes>
                <Route path="/" element={<MarketDataRoute />} />
                <Route path="/analysis" element={<MarketAnalysisRoute />} />
                <Route path="/data" element={<DataLibraryRoute />} />
                <Route path="/market-data" element={<MarketDataRoute />} />
                <Route path="/backtest" element={<BacktestRunner />} />
                <Route path="/results" element={<BacktestResultsPage />} />
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
