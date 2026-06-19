import { useState, useCallback } from 'react';
import { ConfigProvider, App as AntApp, Modal, Tabs } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import AppLayout from './components/AppLayout';
import FileUploader from './components/FileUploader';
import StockInfoBar from './components/StockInfoBar';
import ImportResultPanel from './components/ImportResultPanel';
import IndicatorPanel from './components/IndicatorPanel';
import ChartContainer from './features/chart/ChartContainer';
import DataLibrary from './features/dataLibrary/DataLibrary';
import BacktestRunner from './features/backtest/BacktestRunner';
import BacktestResultsPage from './features/backtestResults/BacktestResultsPage';
import StrategyStudioPage from './features/strategyStudio/StrategyStudioPage';
import SaveDatasetModal from './features/dataLibrary/SaveDatasetModal';
import { useImport } from './features/import/useImport';
import { useCandleStore } from './stores/useCandleStore';
import { computeChecksum, findDuplicateByChecksum, saveDataset } from './db/marketDataRepository';
import type { ImportResult } from './models';

type TabKey = 'chart' | 'data' | 'backtest' | 'results' | 'studio';

export default function App() {
  const { importFile, importFiles, loading } = useImport();
  const importResult = useCandleStore((state) => state.importResult);
  const [alertResult, setAlertResult] = useState<ImportResult | null>(null);
  const [activeTab, setActiveTab] = useState<TabKey>('chart');
  const [saveModalOpen, setSaveModalOpen] = useState(false);
  const [batchSummary, setBatchSummary] = useState<string[] | null>(null);

  const handleImport = useCallback(async (files: File[]) => {
    const results = files.length === 1
      ? [await importFile(files[0])]
      : await importFiles(files);
    const result = [...results].reverse().find((item) => item.success)
      ?? results[results.length - 1];
    if (result) {
      useCandleStore.getState().setCandles(result.candles);
      useCandleStore.getState().setImportResult(result);
      setActiveTab('chart');
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
        if (await findDuplicateByChecksum(checksum)) {
          skipped++;
          continue;
        }
        const now = new Date().toISOString();
        const baseName = item.fileName.replace(/\.xlsx$/i, '');
        await saveDataset({
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
  }, [importFile, importFiles]);

  const handleSaveToDb = useCallback(() => {
    setSaveModalOpen(true);
  }, []);

  const topBar = (
    <>
      <FileUploader onImport={handleImport} loading={loading} />
      {importResult && (
        <>
          <StockInfoBar
            result={importResult}
            onSaveToDb={handleSaveToDb}
          />
        </>
      )}
    </>
  );

  const tabBar = (
    <Tabs
      activeKey={activeTab}
      onChange={(key) => setActiveTab(key as TabKey)}
      items={[
        { key: 'chart', label: '行情分析' },
        { key: 'data', label: '数据管理' },
        { key: 'backtest', label: '策略回测' },
        { key: 'results', label: '回测结果' },
        { key: 'studio', label: '策略工作室' },
      ]}
    />
  );

  const leftPanel = activeTab === 'chart' ? <IndicatorPanel /> : undefined;

  const center = (() => {
    switch (activeTab) {
      case 'chart':
        return <ChartContainer />;
      case 'data':
        return <DataLibrary onOpen={() => setActiveTab('chart')} />;
      case 'backtest':
        return <BacktestRunner />;
      case 'results':
        return <BacktestResultsPage />;
      case 'studio':
        return <StrategyStudioPage />;
    }
  })();

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
          center={center}
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
