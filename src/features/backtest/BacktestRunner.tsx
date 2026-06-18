import { useEffect, useState } from 'react';
import {
  Row,
  Col,
  Button,
  Select,
  Space,
  Typography,
  Progress,
  Alert,
  Tag,
} from 'antd';
import { PlayCircleOutlined, StopOutlined, HistoryOutlined } from '@ant-design/icons';
import StrategyConfigPanel from './StrategyConfigPanel';
import BacktestConfigPanel from './BacktestConfigPanel';
import ChartContainer from '@/features/chart/ChartContainer';
import { useBacktest } from './useBacktest';
import { useCandleStore } from '@/stores/useCandleStore';
import { useStrategyStore } from '@/stores/useStrategyStore';
import { useBacktestStore } from '@/stores/useBacktestStore';
import { getDatasets, getCandlesByDataset } from '@/db/marketDataRepository';
import { computeChecksum } from '@/db/marketDataRepository';
import type { MarketDataset } from '@/models';

const { Text, Title } = Typography;

export default function BacktestRunner() {
  const [datasets, setDatasets] = useState<MarketDataset[]>([]);
  const [selectedDatasetId, setSelectedDatasetId] = useState<string | null>(null);
  const [loadingDatasets, setLoadingDatasets] = useState(false);

  const candles = useCandleStore((s) => s.candles);
  const setCandles = useCandleStore((s) => s.setCandles);
  const setImportResult = useCandleStore((s) => s.setImportResult);

  const activeStrategyId = useStrategyStore((s) => s.activeStrategyId);
  const activeParams = useStrategyStore((s) => s.activeParams);
  const config = useBacktestStore((s) => s.config);
  const addResult = useBacktestStore((s) => s.addResult);
  const setSignals = useBacktestStore((s) => s.setSignals);

  const { run, cancel, status, progress, result, error } = useBacktest();

  useEffect(() => {
    setLoadingDatasets(true);
    getDatasets().then((ds) => {
      setDatasets(ds);
      setLoadingDatasets(false);
      if (ds.length > 0 && !selectedDatasetId) {
        setSelectedDatasetId(ds[0].id);
      }
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSelectDataset = async (id: string) => {
    setSelectedDatasetId(id);
    const ds = datasets.find((d) => d.id === id);
    if (ds) {
      const loadedCandles = await getCandlesByDataset(id);
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

    const cs = computeChecksum(candles);
    run(
      candles,
      activeStrategyId,
      activeParams,
      config,
      ds.id,
      cs,
      `${ds.symbol} - ${activeStrategyId} - ${new Date().toLocaleString()}`,
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
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Top bar */}
      <div
        style={{
          padding: '8px 16px',
          borderBottom: '1px solid #f0f0f0',
          background: '#fff',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          flexShrink: 0,
        }}
      >
        <Text strong>数据集:</Text>
        <Select
          value={selectedDatasetId}
          onChange={handleSelectDataset}
          loading={loadingDatasets}
          style={{ minWidth: 200 }}
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
      <div style={{ flex: 1, overflow: 'hidden' }}>
        <Row style={{ height: '100%' }}>
          {/* Left: Config panels */}
          <Col
            flex="320px"
            style={{
              height: '100%',
              overflow: 'auto',
              borderRight: '1px solid #f0f0f0',
              padding: 8,
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}
          >
            <StrategyConfigPanel />
            <BacktestConfigPanel />
          </Col>

          {/* Center: Chart */}
          <Col flex="1" style={{ height: '100%', overflow: 'hidden' }}>
            {candles.length > 0 ? (
              <ChartContainer />
            ) : (
              <div
                style={{
                  height: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Text type="secondary">
                  {datasets.length === 0
                    ? '请先在数据管理中导入并保存行情数据'
                    : '请选择数据集以查看行情'}
                </Text>
              </div>
            )}
          </Col>
        </Row>
      </div>
    </div>
  );
}
