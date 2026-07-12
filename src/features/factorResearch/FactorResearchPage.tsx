import { Fragment, useEffect, useMemo, useState, type CSSProperties } from 'react';
import {
  Alert,
  App,
  Button,
  DatePicker,
  Empty,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
  Table,
  Tag,
  Tabs,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  BarChartOutlined,
  CalculatorOutlined,
  DatabaseOutlined,
  LineChartOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { WorkbenchPanel } from '@/components/WorkbenchPanel';
import AutomatedMiningPanel from './AutomatedMiningPanel';
import {
  cancelFactorRun,
  fetchFactorRuns,
  fetchFactorRunDailySeries,
  fetchFactorRunReport,
  fetchFactors,
  interpretFactorRunReport,
  retryFactorRun,
  fetchResearchSnapshotFreshness,
  runCompositeFactorResearch,
  runFactorResearch,
  updateResearchSnapshot,
  type CompositeFactorReport,
  type CompositeFactorRunRequest,
  type CompositeFactorWeight,
  type DailyFactorMetric,
  type FactorCorrelationMetric,
  type FactorCatalogItem,
  type FactorReport,
  type FactorRunRequest,
  type FactorRunSummary,
  type FactorReportInterpretation,
  type LayerMetric,
  type ResearchSnapshotFreshness,
} from './api';

const { RangePicker } = DatePicker;
const { Text, Title } = Typography;

const DEFAULT_RANGE: [dayjs.Dayjs, dayjs.Dayjs] = [
  dayjs('2026-06-01'),
  dayjs('2026-06-30'),
];

const SNAPSHOT_FRESHNESS_CACHE_KEY = 'quant-factor-research-snapshot-freshness-v1';

interface SnapshotFreshnessCache {
  checkedDate: string;
  checkedAt: string;
  freshness: ResearchSnapshotFreshness;
}

type FormValues = {
  factorId: string;
  range: [dayjs.Dayjs, dayjs.Dayjs];
  horizonDays: number;
  layers: number;
  markets?: string[];
  minDailyAmount?: number;
};

type CompositeFormValues = {
  factorIds: string[];
  range: [dayjs.Dayjs, dayjs.Dayjs];
  validationStartDate?: dayjs.Dayjs;
  horizonDays: number;
  layers: number;
  weighting: CompositeFactorRunRequest['weighting'];
  manualWeights?: string;
  markets?: string[];
  minDailyAmount?: number;
};

function percent(value: number | null | undefined, digits = 2): string {
  return value == null || !Number.isFinite(value) ? '—' : `${(value * 100).toFixed(digits)}%`;
}

function decimal(value: number | null | undefined, digits = 4): string {
  return value == null || !Number.isFinite(value) ? '—' : value.toFixed(digits);
}

function directionLabel(direction: FactorCatalogItem['definition']['direction']) {
  if (direction === 'higher-is-better') return <Tag color="blue">高值优先</Tag>;
  if (direction === 'lower-is-better') return <Tag color="purple">低值优先</Tag>;
  return <Tag>研究观察</Tag>;
}

function statusColor(status: FactorRunSummary['status']) {
  if (status === 'completed') return 'success';
  if (status === 'failed') return 'error';
  if (status === 'canceled' || status === 'cancelled') return 'default';
  return 'processing';
}

function statusText(status: FactorRunSummary['status']) {
  if (status === 'completed') return '完成';
  if (status === 'failed') return '失败';
  if (status === 'running') return '运行中';
  if (status === 'pending') return '等待中';
  return '已取消';
}

function readCachedSnapshotFreshness(): ResearchSnapshotFreshness | null {
  try {
    const cached = JSON.parse(localStorage.getItem(SNAPSHOT_FRESHNESS_CACHE_KEY) ?? 'null') as SnapshotFreshnessCache | null;
    if (!cached || cached.checkedDate !== dayjs().format('YYYY-MM-DD')) return null;
    return cached.freshness;
  } catch {
    return null;
  }
}

function writeCachedSnapshotFreshness(freshness: ResearchSnapshotFreshness): void {
  try {
    const now = new Date();
    const payload: SnapshotFreshnessCache = {
      checkedDate: dayjs(now).format('YYYY-MM-DD'),
      checkedAt: now.toISOString(),
      freshness,
    };
    localStorage.setItem(SNAPSHOT_FRESHNESS_CACHE_KEY, JSON.stringify(payload));
  } catch {
    // Ignore storage failures; the live API result is still shown.
  }
}

export default function FactorResearchPage() {
  const { message } = App.useApp();
  const [form] = Form.useForm<FormValues>();
  const [compositeForm] = Form.useForm<CompositeFormValues>();
  const [factors, setFactors] = useState<FactorCatalogItem[]>([]);
  const [runs, setRuns] = useState<FactorRunSummary[]>([]);
  const [selectedFactorId, setSelectedFactorId] = useState('momentum_20');
  const [report, setReport] = useState<FactorReport | null>(null);
  const [compositeReport, setCompositeReport] = useState<CompositeFactorReport | null>(null);
  const [reportRunId, setReportRunId] = useState<string | null>(null);
  const [dailyPage, setDailyPage] = useState(1);
  const [dailyPageSize, setDailyPageSize] = useState(10);
  const [dailyTotal, setDailyTotal] = useState(0);
  const [dailyLoading, setDailyLoading] = useState(false);
  const [loadingFactors, setLoadingFactors] = useState(false);
  const [loadingRuns, setLoadingRuns] = useState(false);
  const [running, setRunning] = useState(false);
  const [actionRunId, setActionRunId] = useState<string | null>(null);
  const [snapshotFreshness, setSnapshotFreshness] = useState<ResearchSnapshotFreshness | null>(null);
  const [loadingSnapshot, setLoadingSnapshot] = useState(false);
  const [updatingSnapshot, setUpdatingSnapshot] = useState(false);
  const [interpretation, setInterpretation] = useState<FactorReportInterpretation | null>(null);
  const [interpreting, setInterpreting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedFactor = useMemo(
    () => factors.find((item) => item.definition.id === selectedFactorId),
    [factors, selectedFactorId],
  );

  const loadFactors = async () => {
    setLoadingFactors(true);
    setError(null);
    try {
      const result = await fetchFactors();
      setFactors(result.items);
      if (!result.items.some((item) => item.definition.id === selectedFactorId)) {
        const firstId = result.items[0]?.definition.id;
        if (firstId) {
          setSelectedFactorId(firstId);
          form.setFieldValue('factorId', firstId);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '因子目录加载失败');
    } finally {
      setLoadingFactors(false);
    }
  };

  const loadRuns = async () => {
    setLoadingRuns(true);
    try {
      setRuns((await fetchFactorRuns(20)).items);
    } catch {
      message.warning('因子运行历史暂时不可用');
    } finally {
      setLoadingRuns(false);
    }
  };

  const loadSnapshotFreshness = async (force = false) => {
    if (!force) {
      const cached = readCachedSnapshotFreshness();
      if (cached) {
        setSnapshotFreshness(cached);
        return;
      }
    }
    setLoadingSnapshot(true);
    try {
      const freshness = await fetchResearchSnapshotFreshness();
      setSnapshotFreshness(freshness);
      writeCachedSnapshotFreshness(freshness);
    } catch (err) {
      setSnapshotFreshness(null);
      message.warning(err instanceof Error ? err.message : '研究快照状态暂时不可用');
    } finally {
      setLoadingSnapshot(false);
    }
  };

  useEffect(() => {
    form.setFieldsValue({
      factorId: 'momentum_20',
      range: DEFAULT_RANGE,
      horizonDays: 5,
      layers: 5,
      markets: ['SH', 'SZ'],
    });
    compositeForm.setFieldsValue({
      factorIds: ['momentum_20', 'reversal_5'],
      range: [dayjs('2026-06-01'), dayjs('2026-06-20')],
      validationStartDate: dayjs('2026-06-11'),
      horizonDays: 5,
      layers: 5,
      weighting: 'equal',
      markets: ['SH', 'SZ'],
    });
    void loadFactors();
    void loadRuns();
    void loadSnapshotFreshness();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleUpdateSnapshot = async () => {
    setUpdatingSnapshot(true);
    setError(null);
    try {
      const result = await updateResearchSnapshot();
      setSnapshotFreshness(result.after);
      writeCachedSnapshotFreshness(result.after);
      message.success(`快照已更新：${result.verification.rowCount.toLocaleString('zh-CN')} 行`);
      await Promise.all([loadFactors(), loadRuns()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : '研究快照更新失败');
      await loadSnapshotFreshness(true);
    } finally {
      setUpdatingSnapshot(false);
    }
  };

  const handleRun = async (values: FormValues) => {
    const payload: FactorRunRequest = {
      factorId: values.factorId,
      startDate: values.range[0].format('YYYY-MM-DD'),
      endDate: values.range[1].format('YYYY-MM-DD'),
      horizonDays: values.horizonDays,
      layers: values.layers,
      markets: values.markets,
      minDailyAmount: values.minDailyAmount,
    };
    setRunning(true);
    setError(null);
    try {
      const result = await runFactorResearch(payload);
      setReport(result.report);
      setCompositeReport(null);
      setReportRunId(result.runId);
      setInterpretation(null);
      setDailyPage(1);
      setDailyPageSize(10);
      setDailyTotal(result.report.daily.length);
      message.success(`因子报告已保存：${result.runId.slice(0, 8)}`);
      await loadRuns();
    } catch (err) {
      setError(err instanceof Error ? err.message : '因子研究运行失败');
    } finally {
      setRunning(false);
    }
  };

  const handleCompositeRun = async (values: CompositeFormValues) => {
    const payload: CompositeFactorRunRequest = {
      factorIds: values.factorIds,
      startDate: values.range[0].format('YYYY-MM-DD'),
      endDate: values.range[1].format('YYYY-MM-DD'),
      validationStartDate: values.validationStartDate?.format('YYYY-MM-DD'),
      horizonDays: values.horizonDays,
      layers: values.layers,
      weighting: values.weighting,
      manualWeights: values.weighting === 'manual' ? parseManualWeights(values.manualWeights) : undefined,
      markets: values.markets,
      minDailyAmount: values.minDailyAmount,
    };
    setRunning(true);
    setError(null);
    try {
      const result = await runCompositeFactorResearch(payload);
      setCompositeReport(result.report);
      setReport(null);
      setReportRunId(result.runId);
      setInterpretation(null);
      setDailyPage(1);
      setDailyPageSize(10);
      setDailyTotal(result.report.daily.length);
      message.success(`多因子报告已保存：${result.runId.slice(0, 8)}`);
      await loadRuns();
    } catch (err) {
      setError(err instanceof Error ? err.message : '多因子研究运行失败');
    } finally {
      setRunning(false);
    }
  };

  const handleOpenRunReport = async (runId: string) => {
    setRunning(true);
    setError(null);
    try {
      const [detail, dailySeries] = await Promise.all([
        fetchFactorRunReport(runId),
        fetchFactorRunDailySeries(runId, 1, dailyPageSize),
      ]);
      const reportWithDaily = {
        ...detail.report,
        daily: dailySeries.items,
      };
      if ('factors' in detail.report) {
        setCompositeReport(reportWithDaily as CompositeFactorReport);
        setReport(null);
      } else {
        setReport(reportWithDaily as FactorReport);
        setCompositeReport(null);
      }
      setReportRunId(runId);
      setInterpretation(null);
      setDailyPage(dailySeries.page);
      setDailyPageSize(dailySeries.pageSize);
      setDailyTotal(dailySeries.total);
      message.success(`报告已打开，已加载 ${dailySeries.items.length}/${dailySeries.total} 条 IC 序列`);
    } catch (err) {
      setError(err instanceof Error ? err.message : '报告读取失败');
    } finally {
      setRunning(false);
    }
  };

  const handleDailyPageChange = async (page: number, pageSize: number) => {
    if (!reportRunId || !report) return;
    setDailyLoading(true);
    setError(null);
    try {
      const series = await fetchFactorRunDailySeries(reportRunId, page, pageSize);
      setReport((current) => (current ? { ...current, daily: series.items } : current));
      setDailyPage(series.page);
      setDailyPageSize(series.pageSize);
      setDailyTotal(series.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'IC 序列分页读取失败');
    } finally {
      setDailyLoading(false);
    }
  };

  const handleCancelRun = async (runId: string) => {
    setActionRunId(runId);
    setError(null);
    try {
      await cancelFactorRun(runId);
      message.success('任务已取消');
      await loadRuns();
    } catch (err) {
      setError(err instanceof Error ? err.message : '任务取消失败');
    } finally {
      setActionRunId(null);
    }
  };

  const handleRetryRun = async (runId: string) => {
    setActionRunId(runId);
    setError(null);
    try {
      const result = await retryFactorRun(runId);
      if ('factors' in result.report) {
        setCompositeReport(result.report);
        setReport(null);
      } else {
        setReport(result.report);
        setCompositeReport(null);
      }
      setReportRunId(result.runId);
      setInterpretation(null);
      setDailyPage(1);
      setDailyPageSize(10);
      setDailyTotal(result.report.daily.length);
      message.success(`重试成功：${result.runId.slice(0, 8)}`);
      await loadRuns();
    } catch (err) {
      setError(err instanceof Error ? err.message : '任务重试失败');
      await loadRuns();
    } finally {
      setActionRunId(null);
    }
  };

  const handleInterpretReport = async () => {
    if (!reportRunId) {
      message.warning('请先查看一个已完成报告');
      return;
    }
    setInterpreting(true);
    setError(null);
    try {
      const result = await interpretFactorRunReport(reportRunId);
      setInterpretation(result);
      message.success('智能体解读已生成');
    } catch (err) {
      setError(err instanceof Error ? err.message : '智能体解读失败');
    } finally {
      setInterpreting(false);
    }
  };

  const factorColumns: ColumnsType<FactorCatalogItem> = [
    {
      title: '因子',
      dataIndex: ['definition', 'name'],
      width: 174,
      render: (_, row) => (
        <button
          type="button"
          className={`factor-name-button${row.definition.id === selectedFactorId ? ' is-active' : ''}`}
          onClick={() => {
            setSelectedFactorId(row.definition.id);
            form.setFieldValue('factorId', row.definition.id);
          }}
        >
          <strong>{row.definition.name}</strong>
          <span>{row.definition.id}</span>
        </button>
      ),
    },
    {
      title: '方向',
      width: 92,
      render: (_, row) => directionLabel(row.definition.direction),
    },
    {
      title: '预热',
      dataIndex: ['definition', 'warmupDays'],
      width: 58,
      render: (value: number) => `${value} 日`,
    },
  ];

  const runColumns: ColumnsType<FactorRunSummary> = [
    {
      title: '因子版本',
      dataIndex: 'factorVersionId',
      width: 150,
      render: (value: string) => <Text code>{value}</Text>,
    },
    {
      title: '区间',
      width: 190,
      responsive: ['sm'],
      render: (_, row) => `${row.dateStart} ~ ${row.dateEnd}`,
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (value: FactorRunSummary['status']) => <Tag color={statusColor(value)}>{statusText(value)}</Tag>,
    },
    {
      title: '交易日',
      dataIndex: 'completedDates',
      width: 80,
    },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      width: 180,
      responsive: ['md'],
      render: (value: string) => new Date(value).toLocaleString('zh-CN'),
    },
    {
      title: '操作',
      width: 150,
      render: (_, row) => (
        <Space size={6}>
          <Button
            size="small"
            disabled={row.status !== 'completed'}
            onClick={() => { void handleOpenRunReport(row.id); }}
          >
            查看
          </Button>
          {['failed', 'canceled', 'cancelled'].includes(row.status) && (
            <Button
              size="small"
              loading={actionRunId === row.id}
              onClick={() => { void handleRetryRun(row.id); }}
            >
              重试
            </Button>
          )}
          {['pending', 'running'].includes(row.status) && (
            <Button
              size="small"
              danger
              loading={actionRunId === row.id}
              onClick={() => { void handleCancelRun(row.id); }}
            >
              取消
            </Button>
          )}
        </Space>
      ),
    },
  ];

  return (
    <div className="factor-page">
      <div className="factor-page-head">
        <div>
          <Space size={8}>
            <DatabaseOutlined />
            <Text type="secondary">第六阶段</Text>
          </Space>
          <Title level={2}>因子研究</Title>
        </div>
        <Space wrap>
          <Button icon={<ReloadOutlined />} onClick={() => { void loadFactors(); void loadRuns(); void loadSnapshotFreshness(true); }}>
            刷新
          </Button>
          <Button
            type="primary"
            icon={<CalculatorOutlined />}
            loading={running}
            onClick={() => form.submit()}
          >
            运行研究
          </Button>
        </Space>
      </div>

      {error && (
        <Alert
          className="factor-alert"
          type="error"
          showIcon
          message={error}
        />
      )}

      <SnapshotFreshnessBanner
        freshness={snapshotFreshness}
        loading={loadingSnapshot}
        updating={updatingSnapshot}
        onRefresh={() => { void loadSnapshotFreshness(true); }}
        onUpdate={() => { void handleUpdateSnapshot(); }}
      />

      <div className="factor-workbench">
        <aside className="factor-console">
          <section className="factor-panel factor-library-panel">
            <WorkbenchPanel title="因子库" subtitle={`${factors.length} 个可用因子`}>
              <Table
                className="factor-library-table"
                rowKey={(row) => row.versionId}
                size="small"
                loading={loadingFactors}
                columns={factorColumns}
                dataSource={factors}
                pagination={false}
                scroll={{ y: 300 }}
                tableLayout="fixed"
              />
            </WorkbenchPanel>
          </section>

          <section className="factor-panel factor-config-panel">
            <WorkbenchPanel
              title="运行配置"
              subtitle={selectedFactor?.versionId ?? '选择因子后运行研究'}
            >
              <Tabs
                size="small"
                items={[
                  {
                    key: 'single',
                    label: '单因子',
                    forceRender: true,
                    children: (
                      <Form
                        form={form}
                        layout="vertical"
                        onFinish={handleRun}
                        className="factor-run-form"
                      >
                        <Form.Item name="factorId" label="因子" rules={[{ required: true }]}>
                          <Select
                            options={factorOptions(factors)}
                            onChange={setSelectedFactorId}
                          />
                        </Form.Item>
                        <SharedRunFields />
                      </Form>
                    ),
                  },
                  {
                    key: 'composite',
                    label: '多因子合成',
                    forceRender: true,
                    children: (
                      <Form
                        form={compositeForm}
                        layout="vertical"
                        onFinish={handleCompositeRun}
                        className="factor-run-form"
                      >
                        <Form.Item name="factorIds" label="因子组合" rules={[{ required: true }]}>
                          <Select mode="multiple" options={factorOptions(factors)} />
                        </Form.Item>
                        <Form.Item name="range" label="研究区间" rules={[{ required: true }]}>
                          <RangePicker allowClear={false} />
                        </Form.Item>
                        <Form.Item name="validationStartDate" label="验证区间起点">
                          <DatePicker />
                        </Form.Item>
                        <div className="factor-form-grid">
                          <Form.Item name="horizonDays" label="持有期" rules={[{ required: true }]}>
                            <InputNumber min={1} max={60} suffix="日" />
                          </Form.Item>
                          <Form.Item name="layers" label="分层数" rules={[{ required: true }]}>
                            <InputNumber min={2} max={20} />
                          </Form.Item>
                        </div>
                        <Form.Item name="weighting" label="权重方式" rules={[{ required: true }]}>
                          <Select
                            options={[
                              { value: 'equal', label: '等权' },
                              { value: 'ic', label: 'IC 加权' },
                              { value: 'rankIc', label: 'RankIC 加权' },
                              { value: 'manual', label: '手动权重' },
                            ]}
                          />
                        </Form.Item>
                        <Form.Item shouldUpdate={(prev, current) => prev.weighting !== current.weighting} noStyle>
                          {({ getFieldValue }) => getFieldValue('weighting') === 'manual' && (
                            <Form.Item
                              name="manualWeights"
                              label="手动权重"
                              rules={[{ required: true, message: '请输入 factor:weight 列表' }]}
                            >
                              <Input placeholder="momentum_20:2,reversal_5:-1" />
                            </Form.Item>
                          )}
                        </Form.Item>
                        <Form.Item name="markets" label="市场">
                          <MarketSelect />
                        </Form.Item>
                        <Form.Item name="minDailyAmount" label="成交额下限">
                          <InputNumber min={0} step={10000000} suffix="元" />
                        </Form.Item>
                        <Button type="primary" htmlType="submit" loading={running} icon={<CalculatorOutlined />}>
                          运行多因子
                        </Button>
                      </Form>
                    ),
                  },
                ]}
              />
              {selectedFactor && (
                <div className="factor-definition-note">
                  <Text strong>{selectedFactor.definition.name}</Text>
                  <Text type="secondary">{selectedFactor.definition.description}</Text>
                </div>
              )}
            </WorkbenchPanel>
          </section>
        </aside>

        <main className="factor-research-canvas">
          <section className="factor-panel factor-report-panel">
            <WorkbenchPanel
              title="研究报告"
              subtitle={(report || compositeReport) ? `${(report ?? compositeReport)?.summary.tradingDays} 个交易日` : '运行或打开报告后展示'}
            >
              {compositeReport ? (
                <CompositeReportView report={compositeReport} />
              ) : report ? (
                <FactorReportView
                  report={report}
                  dailyPagination={{
                    current: dailyPage,
                    pageSize: dailyPageSize,
                    total: dailyTotal,
                    loading: dailyLoading,
                    onChange: handleDailyPageChange,
                  }}
                />
              ) : (
                <Empty description="暂无报告" />
              )}
            </WorkbenchPanel>
          </section>

          <section className="factor-panel factor-history-panel">
            <WorkbenchPanel title="运行历史" subtitle={`${runs.length} 条任务记录`}>
              <Table
                rowKey="id"
                size="small"
                loading={loadingRuns}
                columns={runColumns}
                dataSource={runs}
                pagination={{ pageSize: 6, size: 'small' }}
              />
              <ReportInterpretationPanel
                runId={reportRunId}
                interpretation={interpretation}
                loading={interpreting}
                disabled={!reportRunId || (!report && !compositeReport)}
                onInterpret={() => { void handleInterpretReport(); }}
              />
            </WorkbenchPanel>
          </section>
        </main>
      </div>
      <section className="factor-panel" style={{ marginTop: 16 }}>
        <WorkbenchPanel title="自动因子挖掘" subtitle="验证筛选、锁定测试、人工批准、显式发布">
          <AutomatedMiningPanel />
        </WorkbenchPanel>
      </section>
    </div>
  );
}

function factorOptions(factors: FactorCatalogItem[]) {
  return factors.map((item) => ({
    value: item.definition.id,
    label: `${item.definition.name} (${item.definition.id})`,
  }));
}

function MarketSelect() {
  return (
    <Select
      mode="multiple"
      options={[
        { value: 'SH', label: '沪市' },
        { value: 'SZ', label: '深市' },
        { value: 'BJ', label: '北交所' },
      ]}
    />
  );
}

function ReportInterpretationPanel({
  runId,
  interpretation,
  loading,
  disabled,
  onInterpret,
}: {
  runId: string | null;
  interpretation: FactorReportInterpretation | null;
  loading: boolean;
  disabled: boolean;
  onInterpret: () => void;
}) {
  return (
    <div className="factor-agent-panel">
      <div className="factor-agent-head">
        <div>
          <Text strong>智能体解读报告</Text>
          <Text type="secondary">
            {runId ? `当前报告：${runId.slice(0, 8)}` : '先在运行历史中查看一个完成报告'}
          </Text>
        </div>
        <Button
          type="primary"
          icon={<LineChartOutlined />}
          loading={loading}
          disabled={disabled}
          onClick={onInterpret}
        >
          智能解读报告
        </Button>
      </div>
      {interpretation ? (
        <div className="factor-agent-result markdown-preview">
          <div className="factor-agent-meta">
            <Tag color="blue">{interpretation.model}</Tag>
            <Text type="secondary">{new Date(interpretation.generatedAt).toLocaleString('zh-CN')}</Text>
          </div>
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {interpretation.interpretation}
          </ReactMarkdown>
        </div>
      ) : (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={disabled ? '打开一个已完成报告后可生成智能解读' : '智能体会总结有效性、稳定性、风险和下一步研究建议'}
        />
      )}
    </div>
  );
}

function SnapshotFreshnessBanner({
  freshness,
  loading,
  updating,
  onRefresh,
  onUpdate,
}: {
  freshness: ResearchSnapshotFreshness | null;
  loading: boolean;
  updating: boolean;
  onRefresh: () => void;
  onUpdate: () => void;
}) {
  if (!freshness && !loading) return null;
  const status = freshness?.status ?? 'unavailable';
  const stale = status === 'stale' || status === 'unavailable';
  const tagColor = status === 'current'
    ? 'success'
    : status === 'inconsistent' ? 'error' : 'warning';
  const missingDates = freshness?.missingDates ?? [];
  return (
    <div className="snapshot-freshness-banner">
      <div>
        <Space size={8} wrap>
          <DatabaseOutlined />
          <Text strong>研究快照</Text>
          <Tag color={tagColor}>{snapshotStatusText(status)}</Tag>
          {loading && <Tag>读取中</Tag>}
        </Space>
        <div className="snapshot-freshness-meta">
          <Text type="secondary">
            快照：{freshness?.snapshot.maxDate ?? 'N/A'} / {freshness?.snapshot.rowCount?.toLocaleString('zh-CN') ?? 'N/A'}
          </Text>
          <Text type="secondary">
            MySQL：{freshness?.mysql.maxDate ?? 'N/A'} / {freshness?.mysql.rowCount.toLocaleString('zh-CN') ?? 'N/A'}
          </Text>
          {missingDates.length > 0 && (
            <Text type="secondary">
              缺失日期：{missingDates.slice(0, 8).join(', ')}{missingDates.length > 8 ? ` 等 ${missingDates.length} 日` : ''}
            </Text>
          )}
          {freshness?.message && <Text type="secondary">{freshness.message}</Text>}
        </div>
      </div>
      <Space wrap>
        <Button icon={<ReloadOutlined />} loading={loading} onClick={onRefresh}>
          刷新状态
        </Button>
        {stale && (
          <Button type="primary" icon={<DatabaseOutlined />} loading={updating} onClick={onUpdate}>
            更新快照
          </Button>
        )}
      </Space>
    </div>
  );
}

function snapshotStatusText(status: ResearchSnapshotFreshness['status']) {
  if (status === 'current') return '已追平';
  if (status === 'stale') return '待更新';
  if (status === 'inconsistent') return '需复核';
  return '不可用';
}

function SharedRunFields() {
  return (
    <>
      <Form.Item name="range" label="研究区间" rules={[{ required: true }]}>
        <RangePicker allowClear={false} />
      </Form.Item>
      <div className="factor-form-grid">
        <Form.Item name="horizonDays" label="持有期" rules={[{ required: true }]}>
          <InputNumber min={1} max={60} suffix="日" />
        </Form.Item>
        <Form.Item name="layers" label="分层数" rules={[{ required: true }]}>
          <InputNumber min={2} max={20} />
        </Form.Item>
      </div>
      <Form.Item name="markets" label="市场">
        <MarketSelect />
      </Form.Item>
      <Form.Item name="minDailyAmount" label="成交额下限">
        <InputNumber min={0} step={10000000} suffix="元" />
      </Form.Item>
    </>
  );
}

function parseManualWeights(value: string | undefined): Record<string, number> | undefined {
  if (!value?.trim()) return undefined;
  return Object.fromEntries(value.split(',').map((item) => {
    const [factorId, rawWeight] = item.split(':');
    if (!factorId || rawWeight === undefined) throw new Error('手动权重格式应为 factor:weight,factor:weight');
    const weight = Number(rawWeight);
    if (!Number.isFinite(weight)) throw new Error(`手动权重不是有效数字：${item}`);
    return [factorId.trim(), weight];
  }));
}

function FactorReportView({
  report,
  dailyPagination,
}: {
  report: FactorReport;
  dailyPagination?: {
    current: number;
    pageSize: number;
    total: number;
    loading: boolean;
    onChange: (page: number, pageSize: number) => void;
  };
}) {
  return (
    <div className="factor-report">
      <div className="factor-kpi-strip">
        <MetricBox label="样本数" value={report.summary.sampleCount.toLocaleString('zh-CN')} />
        <MetricBox label="平均 IC" value={decimal(report.summary.averageIc)} />
        <MetricBox label="Rank IC" value={decimal(report.summary.averageRankIc)} />
        <MetricBox label="ICIR" value={decimal(report.summary.icir, 2)} />
        <MetricBox label="多空差" value={percent(report.summary.longShortSpread)} />
      </div>
      <div className="factor-chart-grid">
        <div className="factor-chart-box">
          <div className="factor-chart-title">IC 序列</div>
          <IcSparkline data={report.daily} />
        </div>
        <div className="factor-chart-box">
          <div className="factor-chart-title">分层收益</div>
          <LayerBars data={report.layers} />
        </div>
      </div>
      <Table
        rowKey="tradeDate"
        size="small"
        loading={dailyPagination?.loading}
        columns={[
          { title: '日期', dataIndex: 'tradeDate', width: 110 },
          { title: '样本', dataIndex: 'sampleCount', width: 80 },
          { title: 'IC', dataIndex: 'ic', render: (value) => decimal(value) },
          { title: 'Rank IC', dataIndex: 'rankIc', render: (value) => decimal(value) },
        ]}
        dataSource={report.daily}
        pagination={dailyPagination ? {
          current: dailyPagination.current,
          pageSize: dailyPagination.pageSize,
          total: dailyPagination.total,
          size: 'small',
          showSizeChanger: true,
          pageSizeOptions: [10, 20, 50, 100],
          onChange: dailyPagination.onChange,
        } : { pageSize: 5, size: 'small' }}
      />
    </div>
  );
}

function CompositeReportView({ report }: { report: CompositeFactorReport }) {
  return (
    <div className="factor-report">
      <div className="factor-kpi-strip">
        <MetricBox label="因子数" value={String(report.summary.factorCount)} />
        <MetricBox label="平均 IC" value={decimal(report.summary.averageIc)} />
        <MetricBox label="平均相关" value={decimal(report.summary.averageAbsCorrelation)} />
        <MetricBox label="验证 IC" value={decimal(report.sampleSplit?.validation.averageIc)} />
        <MetricBox label="验证多空" value={percent(report.sampleSplit?.validation.longShortSpread)} />
      </div>
      <div className="factor-chart-grid">
        <div className="factor-chart-box">
          <div className="factor-chart-title">权重</div>
          <WeightTable data={report.weights} />
        </div>
        <div className="factor-chart-box">
          <div className="factor-chart-title">训练 / 验证</div>
          <SplitSummary report={report} />
        </div>
      </div>
      <div className="factor-chart-box">
        <div className="factor-chart-title">相关性矩阵</div>
        <CorrelationMatrix factors={report.factors.map((item) => item.id)} data={report.correlations} />
      </div>
      <div className="factor-chart-grid">
        <div className="factor-chart-box">
          <div className="factor-chart-title">合成 IC 序列</div>
          <IcSparkline data={report.daily} />
        </div>
        <div className="factor-chart-box">
          <div className="factor-chart-title">合成分层收益</div>
          <LayerBars data={report.layers} />
        </div>
      </div>
    </div>
  );
}

function WeightTable({ data }: { data: CompositeFactorWeight[] }) {
  return (
    <Table
      rowKey="factorId"
      size="small"
      pagination={false}
      columns={[
        { title: '因子', dataIndex: 'factorId' },
        { title: '权重', dataIndex: 'weight', render: (value) => decimal(value, 3) },
        { title: '来源', dataIndex: 'source', render: (value) => <Tag>{value}</Tag> },
        { title: '训练 IC', dataIndex: 'trainingIc', render: (value) => decimal(value) },
      ]}
      dataSource={data}
    />
  );
}

function SplitSummary({ report }: { report: CompositeFactorReport }) {
  if (!report.sampleSplit) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="未设置验证区间" />;
  return (
    <div className="factor-split-summary">
      <MetricBox label="训练 IC" value={decimal(report.sampleSplit.train.averageIc)} />
      <MetricBox label="训练多空" value={percent(report.sampleSplit.train.longShortSpread)} />
      <MetricBox label="验证 IC" value={decimal(report.sampleSplit.validation.averageIc)} />
      <MetricBox label="验证多空" value={percent(report.sampleSplit.validation.longShortSpread)} />
    </div>
  );
}

function CorrelationMatrix({
  factors,
  data,
}: {
  factors: string[];
  data: FactorCorrelationMetric[];
}) {
  const lookup = new Map<string, number | null>();
  data.forEach((item) => {
    lookup.set(`${item.factorA}|${item.factorB}`, item.correlation);
    lookup.set(`${item.factorB}|${item.factorA}`, item.correlation);
  });
  return (
    <div className="factor-correlation-matrix" style={{ '--factor-count': factors.length } as CSSProperties}>
      <span />
      {factors.map((factor) => <b key={factor}>{factor}</b>)}
      {factors.map((row) => (
        <Fragment key={row}>
          <b key={`${row}-label`}>{row}</b>
          {factors.map((column) => {
            const value = lookup.get(`${row}|${column}`) ?? null;
            return (
              <i key={`${row}-${column}`} className={correlationClass(value)}>
                {decimal(value, 2)}
              </i>
            );
          })}
        </Fragment>
      ))}
    </div>
  );
}

function correlationClass(value: number | null) {
  if (value == null) return '';
  if (value >= 0.6) return 'is-high-positive';
  if (value <= -0.6) return 'is-high-negative';
  if (value >= 0.2) return 'is-positive';
  if (value <= -0.2) return 'is-negative';
  return '';
}

function MetricBox({ label, value }: { label: string; value: string }) {
  return (
    <div className="factor-metric-box">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function IcSparkline({ data }: { data: DailyFactorMetric[] }) {
  const points = data
    .map((item, index) => ({ x: index, y: item.ic ?? 0 }))
    .filter((item) => Number.isFinite(item.y));
  if (points.length === 0) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="无 IC 数据" />;
  const maxAbs = Math.max(0.01, ...points.map((item) => Math.abs(item.y)));
  const width = 520;
  const height = 160;
  const path = points.map((item, index) => {
    const x = points.length === 1 ? width / 2 : item.x / (points.length - 1) * width;
    const y = height / 2 - item.y / maxAbs * (height * 0.42);
    return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return (
    <svg className="factor-ic-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="IC 序列折线">
      <line x1="0" x2={width} y1={height / 2} y2={height / 2} />
      <path d={path} />
    </svg>
  );
}

function LayerBars({ data }: { data: LayerMetric[] }) {
  if (data.length === 0) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="无分层数据" />;
  const maxAbs = Math.max(0.001, ...data.map((item) => Math.abs(item.averageReturn ?? 0)));
  return (
    <div className="factor-layer-bars">
      {data.map((item) => {
        const value = item.averageReturn ?? 0;
        const height = Math.max(4, Math.abs(value) / maxAbs * 92);
        return (
          <div key={item.layer} className="factor-layer-bar">
            <span>{percent(value)}</span>
            <i className={value >= 0 ? 'is-positive' : 'is-negative'} style={{ height }} />
            <b>L{item.layer}</b>
          </div>
        );
      })}
    </div>
  );
}
