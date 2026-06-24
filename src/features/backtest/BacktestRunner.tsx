import { useEffect, useState } from 'react';
import {
  Button,
  Select,
  Typography,
  Progress,
  Alert,
  Tag,
  Drawer,
  Grid,
  App as AntdApp,
} from 'antd';
import { PlayCircleOutlined, StopOutlined, SettingOutlined } from '@ant-design/icons';
import StrategyConfigPanel from './StrategyConfigPanel';
import BacktestConfigPanel from './BacktestConfigPanel';
import ChartContainer from '@/features/chart/ChartContainer';
import { useBacktest } from './useBacktest';
import { useCandleStore } from '@/stores/useCandleStore';
import { useStrategyStore } from '@/stores/useStrategyStore';
import { useBacktestStore } from '@/stores/useBacktestStore';
import { getRepository } from '@/api/useRepository';
import { computeChecksum } from '@/db/marketDataRepository';
import type { MarketDataset } from '@/models';

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
  const [loadingDatasets, setLoadingDatasets] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
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

  useEffect(() => {
    setLoadingDatasets(true);
    getRepository().getDatasets().then((ds) => {
      setDatasets(ds);
      setLoadingDatasets(false);
      if (ds.length > 0 && !selectedDatasetId) {
        const firstId = ds[0].id;
        setSelectedDatasetId(firstId);
        // Auto-load candles for the first dataset so the chart and run
        // button work immediately after page load.
        getRepository().getCandlesByDataset(firstId).then((loaded) => {
          setCandles(loaded);
          setImportResult({
            success: true,
            fileName: ds[0].sourceFileName ?? ds[0].name,
            symbol: ds[0].symbol,
            dateRange: { from: ds[0].startTime, to: ds[0].endTime },
            totalRows: ds[0].count,
            validRows: ds[0].count,
            errors: [],
            warnings: [],
            candles: loaded,
          });
        });
      }
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSelectDataset = async (id: string) => {
    setSelectedDatasetId(id);
    const ds = datasets.find((d) => d.id === id);
    if (ds) {
      const loadedCandles = await getRepository().getCandlesByDataset(id);
      setCandles(loadedCandles);
      setImportResult({
        success: true,
        fileName: ds.sourceFileName ?? ds.name,
        symbol: ds.symbol,
        dateRange: { from: ds.startTime, to: ds.endTime },
        totalRows: ds.count,
        validRows: ds.count,
        errors: [],
        warnings: [],
        candles: loadedCandles,
      });
    }
  };

  const handleRun = () => {
    if (!selectedDatasetId || candles.length === 0) return;
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
    run(
      runCandles,
      activeStrategyId,
      activeParams,
      config,
      ds.id,
      ds.name,
      cs,
      `${ds.symbol} - ${config.backtestMode === 'dca' ? '定投' : activeStrategyId} - ${new Date().toLocaleString()}`,
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

  return (
    <div className="backtest-page">
      {/* Top bar */}
      <div className="backtest-toolbar">
        <Text strong className="backtest-dataset-label">数据集:</Text>
        <Select
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
          disabled={!selectedDatasetId || candles.length === 0}
        >
          运行回测
        </Button>
        {useSettingsDrawer && (
          <Button
            icon={<SettingOutlined />}
            onClick={() => setSettingsOpen(true)}
            aria-label="打开策略和回测参数"
          >
            参数
          </Button>
        )}
        {isRunning && (
          <Button danger icon={<StopOutlined />} onClick={cancel}>
            取消
          </Button>
        )}

        {status === 'completed' && result && (
          <Tag color="success">完成</Tag>
        )}
        {status === 'failed' && (
          <Tag color="error">失败</Tag>
        )}
        {status === 'cancelled' && (
          <Tag color="warning">已取消</Tag>
        )}
      </div>

      {/* Progress bar */}
      {isRunning && progress && (
        <div style={{ padding: '4px 16px', background: '#fff', flexShrink: 0 }}>
          <Progress percent={progressPercent} size="small" />
          <Text type="secondary" style={{ fontSize: 12 }}>
            {progress.message}
          </Text>
        </div>
      )}

      {/* Error display */}
      {error && (
        <Alert
          type="error"
          message="回测失败"
          description={error}
          closable
          style={{ margin: 8, flexShrink: 0 }}
        />
      )}

      {/* Main content */}
      <div className="backtest-workspace">
        {!useSettingsDrawer && (
          <aside className="backtest-settings-panel" aria-label="策略和回测参数">
            <BacktestSettings maximumTradingDays={candles.length} />
          </aside>
        )}

        <main className="backtest-chart-area">
          {candles.length > 0 ? (
            <ChartContainer />
          ) : (
            <div className="backtest-empty-state">
              <Text type="secondary">
                {datasets.length === 0
                  ? '请先在数据管理中导入并保存行情数据'
                  : '请选择数据集以查看行情'}
              </Text>
            </div>
          )}
        </main>
      </div>

      <Drawer
        title="策略和回测参数"
        placement="left"
        open={useSettingsDrawer && settingsOpen}
        onClose={() => setSettingsOpen(false)}
        size="min(88vw, 360px)"
        styles={{ body: { padding: 8 } }}
        destroyOnHidden
      >
        <BacktestSettings maximumTradingDays={candles.length} />
      </Drawer>
    </div>
  );
}
