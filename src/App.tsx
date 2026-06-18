import { useState } from 'react';
import { ConfigProvider, App as AntApp, Modal } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import AppLayout from './components/AppLayout';
import FileUploader from './components/FileUploader';
import StockInfoBar from './components/StockInfoBar';
import ImportResultPanel from './components/ImportResultPanel';
import IndicatorPanel from './components/IndicatorPanel';
import ChartContainer from './features/chart/ChartContainer';
import { useImport } from './features/import/useImport';
import { useCandleStore } from './stores/useCandleStore';
import type { ImportResult } from './models';

export default function App() {
  const { importFile, importResult, loading } = useImport();
  const [alertResult, setAlertResult] = useState<ImportResult | null>(null);

  const handleImport = async (file: File) => {
    const result = await importFile(file);
    if (result) {
      useCandleStore.getState().setCandles(result.candles);
      useCandleStore.getState().setImportResult(result);
      if (result.errors.length > 0 || result.warnings.length > 0) {
        setAlertResult(result);
      }
    }
  };

  const topBar = (
    <>
      <FileUploader onImport={handleImport} loading={loading} />
      {importResult && <StockInfoBar result={importResult} />}
    </>
  );

  const leftPanel = <IndicatorPanel />;

  const center = <ChartContainer />;

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
      </AntApp>
    </ConfigProvider>
  );
}
