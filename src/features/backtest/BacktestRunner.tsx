import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Button,
  Select,
  Typography,
  Progress,
  Alert,
  Tag,
  Grid,
  Modal,
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
import {
  cancelExperimentRun,
  completeExperimentRun,
  createExperimentRun,
  failExperimentRun,
  getExperimentReport,
  openExperimentLockedTest,
  validateExperimentRun,
} from '@/features/experiments/api';
import { ENGINE_VERSION } from './version';
import { compileAndValidate } from '@/features/visualStrategies/compiler';
import {
  runRobustnessCases,
  runSampleIsolationPlan,
  type RobustnessObservation,
} from '@/features/experiments/robustness';

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
  const [settingsDockOpen, setSettingsDockOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const screens = Grid.useBreakpoint();
  const useSettingsDrawer = !screens.lg;
  const { message, modal } = AntdApp.useApp();
  const [completedExperimentRunId, setCompletedExperimentRunId] = useState<string | null>(null);
  const [experimentValidationStatus, setExperimentValidationStatus] = useState<'pending' | 'candidate' | 'rejected' | null>(null);
  const [experimentReportMarkdown, setExperimentReportMarkdown] = useState<string | null>(null);
  const [reportOpen, setReportOpen] = useState(false);
  const [robustnessObservations, setRobustnessObservations] = useState<RobustnessObservation[]>([]);

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
  const activeExperimentVersionId = useBacktestStore((s) => s.activeExperimentVersionId);
  const activeExperimentName = useBacktestStore((s) => s.activeExperimentName);
  const experimentRunIdRef = useRef<string | null>(null);
  const lockedTestIdempotencyKeyRef = useRef<string>('');

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

  const handleRun = async () => {
    if (!selectedDatasetId || candles.length === 0) return;
    const ds = datasets.find((d) => d.id === selectedDatasetId);
    if (!ds) return;
    setCompletedExperimentRunId(null);
    setExperimentValidationStatus(null);
    setExperimentReportMarkdown(null);
    setRobustnessObservations([]);
    lockedTestIdempotencyKeyRef.current = '';

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
    if (activeExperimentVersionId && config.backtestMode === 'strategy') {
      try {
        const experiment = await createExperimentRun({
          experimentVersionId: activeExperimentVersionId,
          idempotencyKey: `browser-${crypto.randomUUID()}`,
          engineVersion: ENGINE_VERSION,
          datasetSnapshot: {
            id: ds.id,
            name: ds.name,
            symbol: ds.symbol,
            startTime: runCandles[0].time,
            endTime: runCandles[runCandles.length - 1].time,
            checksum: cs,
          },
          config,
          strategyParams: activeParams,
        });
        experimentRunIdRef.current = experiment.run.id;
      } catch (experimentError) {
        message.error(
          experimentError instanceof Error
            ? `实验运行创建失败：${experimentError.message}`
            : '实验运行创建失败',
        );
        return;
      }
    } else {
      experimentRunIdRef.current = null;
    }
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
      setSignals(result.signals);
      const experimentRunId = experimentRunIdRef.current;
      void (async () => {
        try {
          await addResult(result);
          if (experimentRunId) {
            const completedRun = await completeExperimentRun(experimentRunId, result);
            setCompletedExperimentRunId(experimentRunId);
            setExperimentValidationStatus(completedRun.validationStatus ?? 'pending');
            message.success('权威回测结果已完成并持久化');
            try {
              const strategy = strategySource === 'visual' && visualStrategyDocument
                ? compileAndValidate(visualStrategyDocument)
                : null;
              const robustnessStrategy = strategy?.success
                ? strategy.strategy
                : getStrategyById(activeStrategyId);
              let report = await getExperimentReport(experimentRunId).catch(() => null);
              if (robustnessStrategy) {
                const robustnessCandles = config.tradingDays > 0 ? candles.slice(-config.tradingDays) : candles;
                const observations = await runRobustnessCases({
                  candles: robustnessCandles,
                  strategy: robustnessStrategy,
                  strategyParams: activeParams,
                  config,
                  baseline: result,
                });
                setRobustnessObservations(observations);
                const validated = await validateExperimentRun(experimentRunId, observations);
                setExperimentValidationStatus(validated.evaluation.status);
                report = validated.report;
              }
              setExperimentReportMarkdown(report?.markdown ?? null);
              message.success('M3 因果与扰动校验已完成');
            } catch (validationError) {
              message.warning(
                validationError instanceof Error
                  ? `权威回测已保存；M3 派生校验失败：${validationError.message}`
                  : '权威回测已保存；M3 派生校验失败',
              );
            }
          }
        } catch (saveError) {
          if (experimentRunId) {
            await failExperimentRun(
              experimentRunId,
              saveError instanceof Error ? saveError.message : '回测结果持久化失败',
            ).catch(() => undefined);
          }
          message.error('回测结果保存或实验关联失败');
        } finally {
          if (experimentRunIdRef.current === experimentRunId) {
            experimentRunIdRef.current = null;
          }
        }
      })();
    }
  }, [result, status]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (status !== 'failed' || !error || !experimentRunIdRef.current) return;
    const runId = experimentRunIdRef.current;
    experimentRunIdRef.current = null;
    void failExperimentRun(runId, error).catch(() => undefined);
  }, [status, error]);

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

  const handleCancel = () => {
    cancel();
    const runId = experimentRunIdRef.current;
    experimentRunIdRef.current = null;
    if (runId) void cancelExperimentRun(runId).catch(() => undefined);
  };

  const handleOpenLockedTest = () => {
    if (!activeExperimentVersionId || !completedExperimentRunId) return;
    modal.confirm({
      title: '确认打开锁定测试？',
      content: '锁定测试对同一实验版本只能打开一次；打开后不能修改该版本参数。',
      okText: '打开一次',
      cancelText: '取消',
      onOk: async () => {
        try {
          if (!lockedTestIdempotencyKeyRef.current) {
            lockedTestIdempotencyKeyRef.current = `locked-${crypto.randomUUID()}`;
          }
          const plan = await openExperimentLockedTest(
            activeExperimentVersionId,
            lockedTestIdempotencyKeyRef.current,
          );
          const compiled = strategySource === 'visual' && visualStrategyDocument
            ? compileAndValidate(visualStrategyDocument)
            : null;
          const lockedStrategy = compiled?.success ? compiled.strategy : getStrategyById(activeStrategyId);
          if (!lockedStrategy) throw new Error('当前策略无法编译为锁定测试运行时');
          if (!result) throw new Error('基准回测结果已失效，请重新运行');
          const lockedCandles = config.tradingDays > 0 ? candles.slice(-config.tradingDays) : candles;
          const sampleResults = await runSampleIsolationPlan({
            candles: lockedCandles,
            strategy: lockedStrategy,
            strategyParams: activeParams,
            config,
            baseline: result,
          }, plan.samplePlan);
          const validated = await validateExperimentRun(
            completedExperimentRunId,
            robustnessObservations,
            sampleResults,
          );
          setExperimentValidationStatus(validated.evaluation.status);
          setExperimentReportMarkdown(validated.report.markdown);
          message.success('锁定测试已打开，门禁已重新计算');
        } catch (openError) {
          message.error(openError instanceof Error ? openError.message : '锁定测试打开失败');
          throw openError;
        }
      },
    });
  };

  return (
    <div className="backtest-page">
      {/* Top bar */}
      <div className="backtest-toolbar">
        <Text strong className="backtest-dataset-label">数据集:</Text>
        {activeExperimentVersionId && (
          <Tag color="purple">实验：{activeExperimentName ?? '已冻结版本'}</Tag>
        )}
        {experimentValidationStatus && (
          <Tag color={experimentValidationStatus === 'candidate' ? 'success' : experimentValidationStatus === 'rejected' ? 'error' : 'warning'}>
            M3 门禁：{experimentValidationStatus === 'candidate' ? '候选' : experimentValidationStatus === 'rejected' ? '拒绝' : '待验证'}
          </Tag>
        )}
        {experimentReportMarkdown && (
          <Button size="small" onClick={() => setReportOpen(true)}>查看实验报告</Button>
        )}
        {experimentValidationStatus === 'pending' && completedExperimentRunId && (
          <Button size="small" danger onClick={handleOpenLockedTest}>打开锁定测试</Button>
        )}
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
        <Button
          type={!useSettingsDrawer && settingsDockOpen ? 'primary' : 'default'}
          icon={<SettingOutlined />}
          onClick={handleSettingsToggle}
          aria-pressed={!useSettingsDrawer && settingsDockOpen}
        >
          参数
        </Button>
        {isRunning && (
          <Button danger icon={<StopOutlined />} onClick={handleCancel}>
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

      <WorkbenchDrawer
        title="策略和回测参数"
        open={useSettingsDrawer && settingsOpen}
        onClose={() => setSettingsOpen(false)}
        styles={{ body: { padding: 8 } }}
      >
        <BacktestSettings maximumTradingDays={candles.length} />
      </WorkbenchDrawer>
      <Modal
        title="M3 实验校验报告"
        open={reportOpen}
        onCancel={() => setReportOpen(false)}
        footer={<Button onClick={() => setReportOpen(false)}>关闭</Button>}
        width={920}
      >
        <article className="experiment-report-markdown markdown-preview">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{experimentReportMarkdown ?? ''}</ReactMarkdown>
        </article>
      </Modal>
    </div>
  );
}
