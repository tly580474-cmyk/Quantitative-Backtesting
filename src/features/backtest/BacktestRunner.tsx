import { useEffect, useRef, useState } from 'react';
import {
  Button,
  Select,
  Typography,
  Progress,
  Alert,
  Tag,
  Spin,
  Grid,
  App as AntdApp,
} from 'antd';
import {
  PlayCircleOutlined,
  StopOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import { WorkbenchDrawer, WorkbenchPanel } from '@/components/WorkbenchPanel';
import StrategyConfigPanel from './StrategyConfigPanel';
import BacktestConfigPanel from './BacktestConfigPanel';
import ChartContainer from '@/features/chart/ChartContainer';
import { useBacktest } from './useBacktest';
import { useCandleStore } from '@/stores/useCandleStore';
import { useStrategyStore } from '@/stores/useStrategyStore';
import { useBacktestStore } from '@/stores/useBacktestStore';
import { getRepository } from '@/api/useRepository';
import { computeChecksum } from '@/db/marketDataRepository';
import { getStrategyById } from '@/features/strategies/registry';
import type { MarketDataset } from '@/models';
import { useMobileLayout } from '@/components/mobile/useMobileLayout';
import './backtest.mobile.css';
import './backtest.workbench.css';

const { Text } = Typography;

function BacktestSettings({ maximumTradingDays }: { maximumTradingDays: number }) {
  const backtestMode = useBacktestStore((s) => s.config.backtestMode);
  return (
    <div className="backtest-settings-stack">
      {backtestMode === 'strategy' && <StrategyConfigPanel />}
      <BacktestConfigPanel maximumTradingDays={maximumTradingDays} />
    </div>
  );
}

export default function BacktestRunner() {
  const [datasets, setDatasets] = useState<MarketDataset[]>([]);
  const [selectedDatasetId, setSelectedDatasetId] = useState<string | null>(null);
  const [loadingDatasets, setLoadingDatasets] = useState(true);
  const [loadingCandles, setLoadingCandles] = useState(false);
  const [datasetError, setDatasetError] = useState<string | null>(null);
  const [settingsDockOpen, setSettingsDockOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const datasetListRequestRef = useRef(0);
  const candleRequestRef = useRef(0);
  const isMobile = useMobileLayout();
  const screens = Grid.useBreakpoint();
  const useSettingsDrawer = !screens.lg;
  const { message } = AntdApp.useApp();

  const candles = useCandleStore((s) => s.candles);
  const setCandles = useCandleStore((s) => s.setCandles);
  const setImportResult = useCandleStore((s) => s.setImportResult);

  const activeStrategyId = useStrategyStore((s) => s.activeStrategyId);
  const activeParams = useStrategyStore((s) => s.activeParams);
  const config = useBacktestStore((s) => s.config);
  const strategySource = useBacktestStore((s) => s.strategySource);
  const visualStrategyDocument = useBacktestStore((s) => s.visualStrategyDocument);
  const addResult = useBacktestStore((s) => s.addResult);
  const setSignals = useBacktestStore((s) => s.setSignals);

  const { run, cancel, status, progress, result, error } = useBacktest();

  const loadDatasetCandles = async (dataset: MarketDataset) => {
    const requestId = ++candleRequestRef.current;
    setLoadingCandles(true);
    setDatasetError(null);
    setCandles([]);
    setImportResult(null);
    try {
      const loaded = await getRepository().getCandlesByDataset(dataset.id);
      if (requestId !== candleRequestRef.current) return;
      setCandles(loaded);
      setImportResult({
        success: true,
        fileName: dataset.sourceFileName ?? dataset.name,
        symbol: dataset.symbol,
        dateRange: { from: dataset.startTime, to: dataset.endTime },
        totalRows: dataset.count,
        validRows: dataset.count,
        errors: [],
        warnings: [],
        candles: loaded,
      });
    } catch (loadError) {
      if (requestId !== candleRequestRef.current) return;
      setCandles([]);
      setImportResult(null);
      setDatasetError(loadError instanceof Error ? loadError.message : '读取数据集行情失败');
    } finally {
      if (requestId === candleRequestRef.current) setLoadingCandles(false);
    }
  };

  const loadDatasets = async () => {
    const requestId = ++datasetListRequestRef.current;
    candleRequestRef.current += 1;
    setLoadingDatasets(true);
    setLoadingCandles(false);
    setDatasetError(null);
    setCandles([]);
    setImportResult(null);
    try {
      const ds = await getRepository().getDatasets();
      if (requestId !== datasetListRequestRef.current) return;
      setDatasets(ds);
      const nextDataset = ds.find((dataset) => dataset.id === selectedDatasetId) ?? ds[0];
      if (nextDataset) {
        setSelectedDatasetId(nextDataset.id);
        // Auto-load candles for the first dataset so the chart and run
        // button work immediately after page load.
        await loadDatasetCandles(nextDataset);
      } else {
        setSelectedDatasetId(null);
        setCandles([]);
        setImportResult(null);
      }
    } catch (loadError) {
      if (requestId !== datasetListRequestRef.current) return;
      setDatasets([]);
      setSelectedDatasetId(null);
      setCandles([]);
      setImportResult(null);
      setDatasetError(loadError instanceof Error ? loadError.message : '读取数据集失败');
    } finally {
      if (requestId === datasetListRequestRef.current) setLoadingDatasets(false);
    }
  };

  useEffect(() => {
    void loadDatasets();
    return () => {
      datasetListRequestRef.current += 1;
      candleRequestRef.current += 1;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSelectDataset = async (id: string) => {
    setSelectedDatasetId(id);
    const ds = datasets.find((d) => d.id === id);
    if (ds) await loadDatasetCandles(ds);
  };

  const handleRun = () => {
    if (loadingDatasets || loadingCandles || datasetError || !selectedDatasetId || candles.length === 0) return;
    const ds = datasets.find((d) => d.id === selectedDatasetId);
    if (!ds) return;

    const runCandles = config.tradingDays > 0 ? candles.slice(-config.tradingDays) : candles;
    const availableCapital = config.backtestMode === 'dca'
      ? config.initialCapital
      : config.initialCapital * config.positionSizing.value;
    const referencePrice = config.backtestMode === 'dca'
      ? runCandles[0]?.close ?? 0
      : runCandles[0]?.open ?? 0;
    const minimumOrderCost = (config.tradingUnitMode === 'stock' ? referencePrice * 100 : 1)
      + config.minimumCommission;

    if (availableCapital < minimumOrderCost) {
      message.error(
        `当前资金最多可用 ¥${availableCapital.toLocaleString()}，` +
        `但最小订单至少需要 ¥${minimumOrderCost.toLocaleString(undefined, { maximumFractionDigits: 2 })}。` +
        `请提高${config.backtestMode === 'dca' ? '首日买入金额' : '初始资金或单次调仓比例'}。`,
        6,
      );
      return;
    }

    const cs = computeChecksum(runCandles);
    const strategyName = config.backtestMode === 'dca'
      ? '定投策略'
      : strategySource === 'visual'
        ? visualStrategyDocument?.name || activeStrategyId
        : getStrategyById(activeStrategyId)?.name || activeStrategyId;
    run(
      runCandles,
      activeStrategyId,
      activeParams,
      config,
      ds.id,
      ds.name,
      cs,
      `${ds.symbol} - ${strategyName} - ${new Date().toLocaleString()}`,
      {
        strategySource,
        strategyDocument: visualStrategyDocument ?? undefined,
      },
    );
  };

  // When result arrives, save it and set signals
  useEffect(() => {
    if (result && status === 'completed') {
      addResult(result);
      setSignals(result.signals);
    }
  }, [result, status]); // eslint-disable-line react-hooks/exhaustive-deps

  const isRunning = status === 'running';
  const progressPercent = progress
    ? Math.round((progress.current / progress.total) * 100)
    : 0;
  const handleSettingsToggle = () => {
    if (useSettingsDrawer) {
      setSettingsOpen(true);
      return;
    }
    setSettingsDockOpen((value) => !value);
  };

  if (isMobile) {
    return (
      <div className="backtest-page backtest-page-mobile">
        <header className="backtest-mobile-header">
          <div className="backtest-mobile-heading backtest-page-heading">
            <Text strong>回测实验</Text>
            <Text type="secondary">选择数据集，配置参数后运行</Text>
          </div>
          <Button
            icon={<SettingOutlined />}
            onClick={() => setSettingsOpen(true)}
            aria-label="打开回测参数"
          >
            参数
          </Button>
        </header>

        <div className="backtest-mobile-controls">
          <div className="backtest-mobile-dataset">
            <Text type="secondary">数据集</Text>
            <Select
              aria-label="回测数据集"
              value={selectedDatasetId}
              onChange={handleSelectDataset}
              loading={loadingDatasets}
              className="backtest-dataset-select"
              placeholder="选择数据集"
              options={datasets.map((ds) => ({
                label: `${ds.name} (${ds.symbol})`,
                value: ds.id,
              }))}
            />
          </div>
          <div className="backtest-mobile-actions backtest-run-actions">
            <Button
              type="primary"
              icon={<PlayCircleOutlined />}
              onClick={handleRun}
              loading={isRunning}
              disabled={loadingDatasets || loadingCandles || Boolean(datasetError) || !selectedDatasetId || candles.length === 0}
              block
            >
              运行回测
            </Button>
            {isRunning && (
              <Button danger icon={<StopOutlined />} onClick={cancel}>
                取消
              </Button>
            )}
            <span className="backtest-run-state" aria-live="polite">
              {status === 'completed' && result && <Tag color="success">完成</Tag>}
              {status === 'failed' && <Tag color="error">失败</Tag>}
              {status === 'cancelled' && <Tag color="warning">已取消</Tag>}
            </span>
          </div>
        </div>

        {datasetError && (
          <Alert
            type="error"
            showIcon
            title="数据集加载失败"
            description={datasetError}
            action={<Button onClick={() => void loadDatasets()}>重试</Button>}
            className="backtest-dataset-alert"
          />
        )}

        {isRunning && progress && (
          <div className="backtest-mobile-progress backtest-progress" role="status" aria-live="polite">
            <Progress percent={progressPercent} size="small" />
            <Text type="secondary">{progress.message}</Text>
          </div>
        )}

        {error && (
          <Alert
            type="error"
            title="回测失败"
            description={error}
            closable
            className="backtest-mobile-error backtest-error"
          />
        )}

        <main className="backtest-chart-area backtest-mobile-chart-area">
          {loadingDatasets ? (
            <div className="backtest-empty-state" role="status" aria-live="polite">
              <Spin size="small" />
              <Text type="secondary">正在读取数据集…</Text>
            </div>
          ) : loadingCandles ? (
            <div className="backtest-empty-state" role="status" aria-live="polite">
              <Spin size="small" />
              <Text type="secondary">正在读取数据集行情…</Text>
            </div>
          ) : datasetError ? (
            <div className="backtest-empty-state">
              <Text type="secondary">数据集行情暂不可用，请点击上方重试</Text>
            </div>
          ) : candles.length > 0 ? (
            <ChartContainer />
          ) : (
            <div className="backtest-empty-state">
              <Text type="secondary">
                {datasets.length === 0
                  ? '暂无可用数据集，请先在数据管理中导入行情数据'
                  : '请选择数据集以查看行情'}
              </Text>
            </div>
          )}
        </main>

        <WorkbenchDrawer
          title="策略和回测参数"
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          styles={{ body: { padding: 8 } }}
        >
          <BacktestSettings maximumTradingDays={candles.length} />
        </WorkbenchDrawer>
      </div>
    );
  }

  return (
    <div className="backtest-page">
      {/* Top bar */}
      <div className="backtest-toolbar" role="toolbar" aria-label="回测实验工具栏">
        <div className="backtest-toolbar-heading">
          <Text strong>策略回测</Text>
          <Text type="secondary">选择数据集，调整参数并运行实验</Text>
        </div>
        <Text strong className="backtest-dataset-label">数据集:</Text>
        <Select
          aria-label="回测数据集"
          value={selectedDatasetId}
          onChange={handleSelectDataset}
          loading={loadingDatasets}
          className="backtest-dataset-select"
          placeholder="选择数据集"
          options={datasets.map((ds) => ({
            label: `${ds.name} (${ds.symbol})`,
            value: ds.id,
          }))}
        />

        <Button
          type="primary"
          icon={<PlayCircleOutlined />}
          onClick={handleRun}
          loading={isRunning}
          disabled={loadingDatasets || loadingCandles || Boolean(datasetError) || !selectedDatasetId || candles.length === 0}
        >
          运行回测
        </Button>
        <Button
          type={!useSettingsDrawer && settingsDockOpen ? 'primary' : 'default'}
          icon={<SettingOutlined />}
          onClick={handleSettingsToggle}
          aria-pressed={!useSettingsDrawer && settingsDockOpen}
        >
          参数
        </Button>
        {isRunning && (
          <Button danger icon={<StopOutlined />} onClick={cancel}>
            取消
          </Button>
        )}

        <span className="backtest-run-state" aria-live="polite">
          {status === 'completed' && result && (
            <Tag color="success">完成</Tag>
          )}
          {status === 'failed' && (
            <Tag color="error">失败</Tag>
          )}
          {status === 'cancelled' && (
            <Tag color="warning">已取消</Tag>
          )}
        </span>
      </div>

      {datasetError && (
        <Alert
          type="error"
          showIcon
            title="数据集加载失败"
          description={datasetError}
          action={<Button onClick={() => void loadDatasets()}>重试</Button>}
          className="backtest-dataset-alert"
        />
      )}

      {/* Progress bar */}
      {isRunning && progress && (
        <div className="backtest-progress" role="status" aria-live="polite">
          <Progress percent={progressPercent} size="small" />
          <Text type="secondary">
            {progress.message}
          </Text>
        </div>
      )}

      {/* Error display */}
      {error && (
        <Alert
          type="error"
        title="回测失败"
          description={error}
          closable
          className="backtest-error"
        />
      )}

      {/* Main content */}
      <div className={settingsDockOpen ? 'backtest-workspace has-settings' : 'backtest-workspace'}>
        {!useSettingsDrawer && settingsDockOpen && (
          <aside className="backtest-settings-panel" aria-label="策略和回测参数">
            <WorkbenchPanel
              title="参数配置"
              subtitle="策略、资金与交易规则"
              closeLabel="收起策略和回测参数"
              onClose={() => setSettingsDockOpen(false)}
            >
              <BacktestSettings maximumTradingDays={candles.length} />
            </WorkbenchPanel>
          </aside>
        )}

        <main className="backtest-chart-area">
          {loadingDatasets ? (
            <div className="backtest-empty-state" role="status" aria-live="polite">
              <Spin size="small" />
              <Text type="secondary">正在读取数据集…</Text>
            </div>
          ) : loadingCandles ? (
            <div className="backtest-empty-state" role="status" aria-live="polite">
              <Spin size="small" />
              <Text type="secondary">正在读取数据集行情…</Text>
            </div>
          ) : datasetError ? (
            <div className="backtest-empty-state">
              <Text type="secondary">数据集行情暂不可用，请点击上方重试</Text>
            </div>
          ) : candles.length > 0 ? (
            <ChartContainer />
          ) : (
            <div className="backtest-empty-state">
              <Text type="secondary">
                {datasets.length === 0
                  ? '暂无可用数据集，请先在数据管理中导入行情数据'
                  : '请选择数据集以查看行情'}
              </Text>
            </div>
          )}
        </main>
      </div>

      <WorkbenchDrawer
        title="策略和回测参数"
        open={useSettingsDrawer && settingsOpen}
        onClose={() => setSettingsOpen(false)}
        styles={{ body: { padding: 8 } }}
      >
        <BacktestSettings maximumTradingDays={candles.length} />
      </WorkbenchDrawer>
    </div>
  );
}
