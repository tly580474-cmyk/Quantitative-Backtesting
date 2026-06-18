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
import SaveDatasetModal from './features/dataLibrary/SaveDatasetModal';
import { useImport } from './features/import/useImport';
import { useCandleStore } from './stores/useCandleStore';
import type { ImportResult } from './models';

type TabKey = 'chart' | 'data' | 'backtest' | 'results';

export default function App() {
  const { importFile, importResult, loading } = useImport();
  const [alertResult, setAlertResult] = useState<ImportResult | null>(null);
  const [activeTab, setActiveTab] = useState<TabKey>('chart');
  const [saveModalOpen, setSaveModalOpen] = useState(false);

  const handleImport = useCallback(async (file: File) => {
    const result = await importFile(file);
    if (result) {
      useCandleStore.getState().setCandles(result.candles);
      useCandleStore.getState().setImportResult(result);
      setActiveTab('chart');
      if (result.errors.length > 0 || result.warnings.length > 0) {
        setAlertResult(result);
      }
    }
  }, [importFile]);

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
      style={{ flex: 1, marginBottom: 0 }}
      items={[
        { key: 'chart', label: '行情分析' },
        { key: 'data', label: '数据管理' },
        { key: 'backtest', label: '策略回测' },
        { key: 'results', label: '回测结果' },
      ]}
    />
  );

  const leftPanel = activeTab === 'chart' ? <IndicatorPanel /> : undefined;

  const center = (() => {
    switch (activeTab) {
      case 'chart':
        return <ChartContainer />;
      case 'data':
        return <DataLibrary />;
      case 'backtest':
        return <BacktestRunner />;
      case 'results':
        return <BacktestResultsPage />;
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
          topBar={
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flex: 1 }}>
              {topBar}
              <div style={{ flex: 1 }} />
              {tabBar}
            </div>
          }
          leftPanel={leftPanel}
          center={center}
        />
        <Modal
          title="导入结果"
          open={alertResult !== null}
          onCancel={() => setAlertResult(null)}
          footer={null}
          width={520}
          destroyOnClose
        >
          {alertResult && <ImportResultPanel result={alertResult} />}
        </Modal>
        <SaveDatasetModal
          open={saveModalOpen}
          onClose={() => setSaveModalOpen(false)}
        />
      </AntApp>
    </ConfigProvider>
  );
}
