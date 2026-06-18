import { ConfigProvider, App as AntApp } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import AppLayout from './components/AppLayout';
import FileUploader from './components/FileUploader';
import StockInfoBar from './components/StockInfoBar';
import ImportResultPanel from './components/ImportResultPanel';
import IndicatorPanel from './components/IndicatorPanel';
import ChartContainer from './features/chart/ChartContainer';
import { useImport } from './features/import/useImport';
import { useCandleStore } from './stores/useCandleStore';

export default function App() {
  const { importFile, importResult, loading } = useImport();
  const clear = useCandleStore((s) => s.clear);

  const handleImport = async (file: File) => {
    const result = await importFile(file);
    if (result) {
      useCandleStore.getState().setCandles(result.candles);
      useCandleStore.getState().setImportResult(result);
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

  const hasImportIssues = Boolean(
    importResult && (importResult.errors.length > 0 || importResult.warnings.length > 0),
  );
  const bottom = hasImportIssues && importResult
    ? <ImportResultPanel result={importResult} />
    : null;

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
          bottom={bottom}
        />
      </AntApp>
    </ConfigProvider>
  );
}
