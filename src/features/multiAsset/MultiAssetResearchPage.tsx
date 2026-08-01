import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  DatePicker,
  Descriptions,
  Drawer,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Progress,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  ApartmentOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  DatabaseOutlined,
  ExperimentOutlined,
  PlusOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  SyncOutlined,
} from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import {
  createMultiAssetPlan,
  cancelMultiAssetRun,
  listMultiAssetPlans,
  listMultiAssetRunArtifacts,
  listMultiAssetRuns,
  retryMultiAssetRun,
  startMultiAssetRun,
} from './api';
import { deriveMultiAssetRunMetrics, multiAssetStageLabel } from './metrics';
import type {
  CreateMultiAssetPlanInput,
  MultiAssetLedgerEntry,
  MultiAssetOrder,
  MultiAssetRunArtifact,
  StoredMultiAssetPlan,
  StoredMultiAssetRun,
} from './types';

const { RangePicker } = DatePicker;
const ACTIVE_STATUSES = new Set(['queued', 'running', 'retry_wait']);

interface PlanFormValues {
  name: string;
  indexCode: string;
  dateRange: [Dayjs, Dayjs];
  frequency: 'weekly' | 'monthly';
  topN: number;
  weighting: 'equal' | 'score';
  maxGrossExposure: number;
  maxSingleWeight: number;
  minCashWeight: number;
  factorVersionId?: string;
  strategyVersionId?: string;
}

const money = (value: number) => new Intl.NumberFormat('zh-CN', {
  style: 'currency', currency: 'CNY', maximumFractionDigits: 2,
}).format(value);

const compactMoney = (value: number) => {
  if (Math.abs(value) >= 100_000_000) return `${(value / 100_000_000).toFixed(2)} 亿`;
  if (Math.abs(value) >= 10_000) return `${(value / 10_000).toFixed(2)} 万`;
  return money(value);
};

function runStatusMeta(run: StoredMultiAssetRun) {
  if (run.status === 'completed') return { color: 'success', label: '已完成', icon: <CheckCircleOutlined /> };
  if (run.status === 'failed') return { color: 'error', label: '失败', icon: null };
  if (run.status === 'dead_letter') return { color: 'error', label: '死信', icon: null };
  if (run.status === 'cancelled') return { color: 'default', label: '已取消', icon: null };
  if (run.status === 'retry_wait') return { color: 'warning', label: '等待重试', icon: <ClockCircleOutlined /> };
  if (run.status === 'running') return { color: 'processing', label: '运行中', icon: <SyncOutlined spin /> };
  return { color: 'default', label: '排队中', icon: <ClockCircleOutlined /> };
}

function EquityCurve({ ledger }: { ledger: MultiAssetLedgerEntry[] }) {
  if (ledger.length < 2) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无足够的权益数据" />;
  const values = ledger.map((item) => item.equity);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const spread = Math.max(max - min, 1);
  const points = values.map((value, index) => {
    const x = (index / (values.length - 1)) * 100;
    const y = 90 - ((value - min) / spread) * 72;
    return `${x},${y}`;
  }).join(' ');
  const area = `0,90 ${points} 100,90`;

  return (
    <div className="multi-asset-equity-chart" role="img" aria-label="组合权益曲线">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none">
        <defs>
          <linearGradient id="multiAssetEquityFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--multi-asset-accent)" stopOpacity="0.38" />
            <stop offset="100%" stopColor="var(--multi-asset-accent)" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        <line x1="0" y1="90" x2="100" y2="90" className="multi-asset-chart-axis" />
        <polygon points={area} fill="url(#multiAssetEquityFill)" />
        <polyline points={points} className="multi-asset-chart-line" />
      </svg>
      <div className="multi-asset-chart-labels">
        <span>{ledger[0]?.tradeDate}</span>
        <strong>{compactMoney(values[values.length - 1] ?? 0)}</strong>
        <span>{ledger[ledger.length - 1]?.tradeDate}</span>
      </div>
    </div>
  );
}

export default function MultiAssetResearchPage() {
  const { message } = App.useApp();
  const [planForm] = Form.useForm<PlanFormValues>();
  const [plans, setPlans] = useState<StoredMultiAssetPlan[]>([]);
  const [runs, setRuns] = useState<StoredMultiAssetRun[]>([]);
  const [selectedPlanId, setSelectedPlanId] = useState<string>();
  const [selectedRunId, setSelectedRunId] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [runOpen, setRunOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [starting, setStarting] = useState(false);
  const [initialCash, setInitialCash] = useState(1_000_000);
  const [artifacts, setArtifacts] = useState<MultiAssetRunArtifact[]>([]);
  const [runActionLoading, setRunActionLoading] = useState(false);

  const selectedPlan = useMemo(
    () => plans.find((plan) => plan.id === selectedPlanId),
    [plans, selectedPlanId],
  );
  const planRuns = useMemo(
    () => runs.filter((run) => run.planVersionId === selectedPlanId),
    [runs, selectedPlanId],
  );
  const selectedRun = useMemo(
    () => planRuns.find((run) => run.id === selectedRunId) ?? planRuns[0],
    [planRuns, selectedRunId],
  );

  const loadData = useCallback(async (quiet = false) => {
    if (quiet) setRefreshing(true);
    else setLoading(true);
    try {
      const [nextPlans, nextRuns] = await Promise.all([
        listMultiAssetPlans(),
        listMultiAssetRuns(undefined, 200),
      ]);
      setPlans(nextPlans);
      setRuns(nextRuns);
      setSelectedPlanId((current) => current && nextPlans.some((item) => item.id === current)
        ? current
        : nextPlans[0]?.id);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '加载多资产研究数据失败');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [message]);

  useEffect(() => { void loadData(); }, [loadData]);

  const hasActiveRun = runs.some((run) => ACTIVE_STATUSES.has(run.status));
  useEffect(() => {
    if (!hasActiveRun) return undefined;
    const timer = window.setInterval(() => void loadData(true), 1500);
    return () => window.clearInterval(timer);
  }, [hasActiveRun, loadData]);

  useEffect(() => {
    if (!selectedRun || !ACTIVE_STATUSES.has(selectedRun.status) || typeof EventSource === 'undefined') return undefined;
    const source = new EventSource(`/api/multi-asset/runs/${encodeURIComponent(selectedRun.id)}/events/stream`);
    source.onmessage = () => void loadData(true);
    const refresh = () => void loadData(true);
    ['progress', 'completed', 'retry_wait', 'dead_letter', 'cancelled'].forEach((type) => source.addEventListener(type, refresh));
    return () => source.close();
  }, [selectedRun, loadData]);

  useEffect(() => {
    if (!planRuns.length) setSelectedRunId(undefined);
    else if (!selectedRunId || !planRuns.some((run) => run.id === selectedRunId)) {
      setSelectedRunId(planRuns[0].id);
    }
  }, [planRuns, selectedRunId]);

  useEffect(() => {
    if (!selectedRun || selectedRun.status !== 'completed') {
      setArtifacts([]);
      return;
    }
    void listMultiAssetRunArtifacts(selectedRun.id).then(setArtifacts).catch(() => setArtifacts([]));
  }, [selectedRun]);

  const cancelRun = async () => {
    if (!selectedRun) return;
    setRunActionLoading(true);
    try {
      const run = await cancelMultiAssetRun(selectedRun.id);
      setRuns((current) => current.map((item) => item.id === run.id ? run : item));
      message.success(run.status === 'cancelled' ? '运行已取消' : '取消请求已提交');
    } catch (error) {
      message.error(error instanceof Error ? error.message : '取消失败');
    } finally { setRunActionLoading(false); }
  };

  const retryRun = async () => {
    if (!selectedRun) return;
    setRunActionLoading(true);
    try {
      const run = await retryMultiAssetRun(selectedRun.id);
      setRuns((current) => current.map((item) => item.id === run.id ? run : item));
      message.success('运行已重新进入队列');
    } catch (error) {
      message.error(error instanceof Error ? error.message : '重试失败');
    } finally { setRunActionLoading(false); }
  };

  const openCreate = () => {
    planForm.setFieldsValue({
      name: `沪深 300 多资产研究 ${dayjs().format('MM-DD HH:mm')}`,
      indexCode: '000300',
      dateRange: [dayjs().subtract(12, 'month').startOf('day'), dayjs().subtract(1, 'day').startOf('day')],
      frequency: 'monthly',
      topN: 10,
      weighting: 'equal',
      maxGrossExposure: 95,
      maxSingleWeight: 10,
      minCashWeight: 5,
    });
    setCreateOpen(true);
  };

  const createPlan = async () => {
    try {
      const values = await planForm.validateFields();
      const investable = Math.min(values.maxGrossExposure, 100 - values.minCashWeight);
      if (values.topN * values.maxSingleWeight < investable) {
        message.error('Top N × 单标的上限不足以承载目标仓位，请提高其一或降低总仓位');
        return;
      }
      setCreating(true);
      const input: CreateMultiAssetPlanInput = {
        name: values.name.trim(),
        config: {
          indexCode: values.indexCode,
          startDate: values.dateRange[0].format('YYYY-MM-DD'),
          endDate: values.dateRange[1].format('YYYY-MM-DD'),
          frequency: values.frequency,
          topN: values.topN,
          weighting: values.weighting,
          maxGrossExposure: values.maxGrossExposure / 100,
          maxSingleWeight: values.maxSingleWeight / 100,
          minCashWeight: values.minCashWeight / 100,
          factorVersionId: values.factorVersionId?.trim() || undefined,
          strategyVersionId: values.strategyVersionId?.trim() || undefined,
        },
      };
      const result = await createMultiAssetPlan(input);
      setCreateOpen(false);
      setSelectedPlanId(result.plan.id);
      await loadData(true);
      message.success(result.reused ? '已复用相同快照计划' : '研究计划已冻结');
    } catch (error) {
      if (error instanceof Error) message.error(error.message);
    } finally {
      setCreating(false);
    }
  };

  const startRun = async () => {
    if (!selectedPlan || !initialCash || initialCash <= 0) return;
    setStarting(true);
    try {
      const result = await startMultiAssetRun(selectedPlan.id, initialCash);
      setRuns((current) => [result.run, ...current.filter((run) => run.id !== result.run.id)]);
      setSelectedRunId(result.run.id);
      setRunOpen(false);
      message.success(result.reused ? '已打开同一运行任务' : '运行已进入队列');
    } catch (error) {
      message.error(error instanceof Error ? error.message : '启动运行失败');
    } finally {
      setStarting(false);
    }
  };

  const metrics = selectedRun ? deriveMultiAssetRunMetrics(selectedRun) : null;
  const completedCount = runs.filter((run) => run.status === 'completed').length;
  const activeCount = runs.filter((run) => ACTIVE_STATUSES.has(run.status)).length;

  const ledgerColumns: ColumnsType<MultiAssetLedgerEntry> = [
    { title: '调仓日', dataIndex: 'tradeDate', width: 112 },
    { title: '现金', dataIndex: 'cash', align: 'right', render: compactMoney },
    { title: '持仓市值', dataIndex: 'marketValue', align: 'right', render: compactMoney },
    { title: '总权益', dataIndex: 'equity', align: 'right', render: (value) => <strong>{compactMoney(value)}</strong> },
    { title: '累计成本', dataIndex: 'cumulativeCosts', align: 'right', render: compactMoney },
    { title: '换手率', dataIndex: 'turnover', align: 'right', render: (value) => `${(Number(value) * 100).toFixed(2)}%` },
    { title: '持仓数', dataIndex: 'positions', align: 'right', render: (value) => value.length },
  ];
  const orderColumns: ColumnsType<MultiAssetOrder> = [
    { title: '交易日', dataIndex: 'tradeDate', width: 112 },
    { title: '标的', dataIndex: 'instrumentKey', width: 130 },
    { title: '方向', dataIndex: 'side', width: 76, render: (value) => <Tag color={value === 'buy' ? 'red' : 'green'}>{value === 'buy' ? '买入' : '卖出'}</Tag> },
    { title: '数量', dataIndex: 'quantity', align: 'right' },
    { title: '成交价', dataIndex: 'fillPrice', align: 'right', render: (value) => Number(value).toFixed(3) },
    { title: '成交额', dataIndex: 'grossAmount', align: 'right', render: compactMoney },
    { title: '费用', dataIndex: 'fees', align: 'right', render: compactMoney },
  ];

  return (
    <div className="multi-asset-page">
      <header className="multi-asset-hero">
        <div>
          <Space size={10} wrap>
            <span className="multi-asset-hero-icon"><ApartmentOutlined /></span>
            <Typography.Title level={2}>多资产研究</Typography.Title>
            <Tag color="blue">M4 基础流程</Tag>
            <Tag icon={<SafetyCertificateOutlined />} color="green">只读快照</Tag>
          </Space>
          <Typography.Paragraph>
            Python 横截面计算，TypeScript 权威撮合；先跑通可复现的研究计划、执行与结果审阅。
          </Typography.Paragraph>
        </div>
        <Space wrap>
          <Button icon={<ReloadOutlined spin={refreshing} />} onClick={() => void loadData(true)}>刷新</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>新建研究计划</Button>
        </Space>
      </header>

      <section className="multi-asset-stat-grid" aria-label="研究运行概览">
        <Card loading={loading}><Statistic title="冻结计划" value={plans.length} prefix={<DatabaseOutlined />} /></Card>
        <Card loading={loading}><Statistic title="全部运行" value={runs.length} prefix={<ExperimentOutlined />} /></Card>
        <Card loading={loading}><Statistic title="执行中" value={activeCount} styles={{ content: { color: activeCount ? '#1677ff' : undefined } }} /></Card>
        <Card loading={loading}><Statistic title="已完成" value={completedCount} styles={{ content: { color: completedCount ? '#16a34a' : undefined } }} /></Card>
      </section>

      <div className="multi-asset-workspace">
        <aside className="multi-asset-sidebar">
          <Card title="研究计划" size="small" loading={loading}>
            <div className="multi-asset-plan-list">
              {plans.length ? plans.map((plan) => (
                <button
                  type="button"
                  key={plan.id}
                  className={`multi-asset-plan-item${selectedPlanId === plan.id ? ' is-active' : ''}`}
                  onClick={() => setSelectedPlanId(plan.id)}
                >
                  <span className="multi-asset-plan-title">{plan.name}</span>
                  <span>沪深 300 · {plan.snapshotConfig.frequency === 'weekly' ? '周频' : '月频'} · Top {plan.snapshotConfig.topN}</span>
                  <span className="multi-asset-plan-hash">快照 {plan.snapshotId.slice(0, 12)}…</span>
                </button>
              )) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无研究计划" />}
            </div>
          </Card>

          <Card title={`运行记录${selectedPlan ? ` · ${planRuns.length}` : ''}`} size="small">
            <div className="multi-asset-run-list">
              {planRuns.length ? planRuns.map((run) => {
                const meta = runStatusMeta(run);
                return (
                  <button
                    type="button"
                    key={run.id}
                    className={`multi-asset-run-item${selectedRun?.id === run.id ? ' is-active' : ''}`}
                    onClick={() => setSelectedRunId(run.id)}
                  >
                    <span><Tag color={meta.color} icon={meta.icon}>{meta.label}</Tag>{dayjs(run.createdAt).format('MM-DD HH:mm')}</span>
                    <strong>{multiAssetStageLabel(run.progress.stage)}</strong>
                    <Progress percent={run.progress.percent} size="small" showInfo={false} status={run.status === 'failed' ? 'exception' : undefined} />
                  </button>
                );
              }) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={selectedPlan ? '尚未运行' : '请先选择计划'} />}
            </div>
          </Card>
        </aside>

        <main className="multi-asset-main">
          {!selectedPlan ? (
            <Card className="multi-asset-empty-card"><Empty description="创建研究计划后，在这里启动并审阅结果"><Button type="primary" onClick={openCreate}>新建研究计划</Button></Empty></Card>
          ) : (
            <>
              <Card
                title={selectedPlan.name}
                extra={<Space wrap>
                  {selectedRun && ACTIVE_STATUSES.has(selectedRun.status) ? <Button danger loading={runActionLoading} onClick={() => void cancelRun()}>取消运行</Button> : null}
                  {selectedRun && ['failed', 'dead_letter', 'cancelled'].includes(selectedRun.status) ? <Button loading={runActionLoading} onClick={() => void retryRun()}>重试</Button> : null}
                  <Button type="primary" icon={<ExperimentOutlined />} onClick={() => setRunOpen(true)}>启动运行</Button>
                </Space>}
              >
                <Descriptions size="small" column={{ xs: 1, sm: 2, lg: 4 }}>
                  <Descriptions.Item label="资产域">沪深 300（{selectedPlan.snapshotConfig.indexCode}）</Descriptions.Item>
                  <Descriptions.Item label="研究区间">{selectedPlan.snapshotConfig.startDate} 至 {selectedPlan.snapshotConfig.endDate}</Descriptions.Item>
                  <Descriptions.Item label="调仓与选股">{selectedPlan.snapshotConfig.frequency === 'weekly' ? '周频' : '月频'} · Top {selectedPlan.snapshotConfig.topN}</Descriptions.Item>
                  <Descriptions.Item label="权重">{selectedPlan.snapshotConfig.weighting === 'equal' ? '等权' : '评分加权'}</Descriptions.Item>
                  <Descriptions.Item label="总仓位上限">{(selectedPlan.snapshotConfig.maxGrossExposure * 100).toFixed(0)}%</Descriptions.Item>
                  <Descriptions.Item label="单标的上限">{(selectedPlan.snapshotConfig.maxSingleWeight * 100).toFixed(0)}%</Descriptions.Item>
                  <Descriptions.Item label="最低现金">{(selectedPlan.snapshotConfig.minCashWeight * 100).toFixed(0)}%</Descriptions.Item>
                  <Descriptions.Item label="治理角色">{selectedPlan.plan.governancePlan?.role ?? '独立研究'}</Descriptions.Item>
                  <Descriptions.Item label="计划哈希"><Typography.Text copyable code>{selectedPlan.planHash.slice(0, 16)}…</Typography.Text></Descriptions.Item>
                </Descriptions>
              </Card>

              {!selectedRun ? (
                <Card className="multi-asset-empty-card"><Empty description="该计划尚无运行记录"><Button type="primary" onClick={() => setRunOpen(true)}>启动第一次运行</Button></Empty></Card>
              ) : ACTIVE_STATUSES.has(selectedRun.status) ? (
                <Card title="运行进度" extra={<Tag color="processing" icon={<SyncOutlined spin />}>自动刷新</Tag>}>
                  <div className="multi-asset-progress-panel">
                    <Progress type="circle" percent={selectedRun.progress.percent} />
                    <div>
                      <Typography.Title level={4}>{multiAssetStageLabel(selectedRun.progress.stage)}</Typography.Title>
                      <Typography.Paragraph type="secondary">运行 ID：{selectedRun.id}</Typography.Paragraph>
                      <Typography.Text type="secondary">任务由服务端调度，页面关闭后仍会继续运行。</Typography.Text>
                    </div>
                  </div>
                </Card>
              ) : selectedRun.status === 'failed' ? (
                <Alert
                  type="error"
                  showIcon
                  message={`运行失败${selectedRun.errorCode ? ` · ${selectedRun.errorCode}` : ''}`}
                  description={selectedRun.errorMessage ?? '服务端未返回具体错误信息'}
                />
              ) : metrics && selectedRun.executionResult ? (
                <>
                  <Card title="组合结果" extra={<Tag color="success" icon={<CheckCircleOutlined />}>结果已固化</Tag>}>
                    <section className="multi-asset-result-stats">
                      <Statistic title="初始资金" value={selectedRun.initialCash} formatter={(value) => compactMoney(Number(value))} />
                      <Statistic title="期末权益" value={metrics.endingEquity ?? 0} formatter={(value) => compactMoney(Number(value))} />
                      <Statistic title="累计收益率" value={(metrics.totalReturn ?? 0) * 100} precision={2} suffix="%" styles={{ content: { color: (metrics.totalReturn ?? 0) >= 0 ? '#16a34a' : '#dc2626' } }} />
                      <Statistic title="交易成本" value={metrics.cumulativeCosts ?? 0} formatter={(value) => compactMoney(Number(value))} />
                      <Statistic title="订单 / 调仓" value={`${metrics.orderCount} / ${metrics.rebalanceCount}`} />
                    </section>
                    <EquityCurve ledger={selectedRun.executionResult.ledger} />
                    {artifacts.length ? <div className="multi-asset-artifacts">
                      <Typography.Text type="secondary">可复核制品</Typography.Text>
                      <Space wrap>{artifacts.map((artifact) => (
                        <Button key={artifact.id} size="small" href={`/api/multi-asset/artifacts/${artifact.id}/download`}>
                          {artifact.kind === 'rebalance_plan' ? '调仓计划' : '执行结果'} · {(artifact.byteSize / 1024).toFixed(1)} KB
                        </Button>
                      ))}</Space>
                    </div> : null}
                  </Card>
                  <Card title="权益账本">
                    <Table rowKey="tradeDate" size="small" columns={ledgerColumns} dataSource={selectedRun.executionResult.ledger} pagination={{ pageSize: 8 }} scroll={{ x: 720 }} />
                  </Card>
                  <Card title={`交易清单 · ${selectedRun.executionResult.orders.length}`}>
                    <Table rowKey={(row) => `${row.tradeDate}-${row.instrumentKey}-${row.side}`} size="small" columns={orderColumns} dataSource={selectedRun.executionResult.orders} pagination={{ pageSize: 10 }} scroll={{ x: 820 }} />
                  </Card>
                </>
              ) : null}
            </>
          )}
        </main>
      </div>

      <Drawer title="新建多资产研究计划" size={560} open={createOpen} onClose={() => setCreateOpen(false)} extra={<Button type="primary" loading={creating} onClick={() => void createPlan()}>冻结计划</Button>}>
        <Alert type="info" showIcon message="计划创建后将绑定只读数据快照" description="当前基础流程开放沪深 300；更多资产域会在数据口径与黄金样例通过后逐步开放。" />
        <Form form={planForm} layout="vertical" className="multi-asset-plan-form">
          <Form.Item name="name" label="计划名称" rules={[{ required: true }, { max: 80 }]}><Input placeholder="例如：沪深 300 月度动量研究" /></Form.Item>
          <Form.Item name="indexCode" label="资产域" rules={[{ required: true }]}><Select options={[{ label: '沪深 300（000300）', value: '000300' }]} /></Form.Item>
          <Form.Item name="dateRange" label="回测区间" rules={[{ required: true }]}><RangePicker style={{ width: '100%' }} allowClear={false} /></Form.Item>
          <div className="multi-asset-form-grid">
            <Form.Item name="frequency" label="调仓周期" rules={[{ required: true }]}><Select options={[{ label: '每周', value: 'weekly' }, { label: '每月', value: 'monthly' }]} /></Form.Item>
            <Form.Item name="topN" label="入选数量" rules={[{ required: true }]}><InputNumber min={1} max={500} style={{ width: '100%' }} /></Form.Item>
            <Form.Item name="weighting" label="权重方式" rules={[{ required: true }]}><Select options={[{ label: '等权', value: 'equal' }, { label: '评分加权', value: 'score' }]} /></Form.Item>
            <Form.Item name="maxGrossExposure" label="总仓位上限（%）" rules={[{ required: true }]}><InputNumber min={1} max={100} style={{ width: '100%' }} /></Form.Item>
            <Form.Item name="maxSingleWeight" label="单标的上限（%）" rules={[{ required: true }]}><InputNumber min={0.1} max={100} step={0.5} style={{ width: '100%' }} /></Form.Item>
            <Form.Item name="minCashWeight" label="最低现金（%）" rules={[{ required: true }]}><InputNumber min={0} max={99} style={{ width: '100%' }} /></Form.Item>
          </div>
          <Typography.Title level={5}>因子与策略治理绑定（可选）</Typography.Title>
          <Typography.Paragraph type="secondary">仅接受已发布的 momentum_20 因子版本，以及快照一致且处于 validated、paper 或 champion 状态的策略版本。</Typography.Paragraph>
          <Form.Item name="factorVersionId" label="已发布因子版本 ID"><Input placeholder="例如 momentum_20:v1" /></Form.Item>
          <Form.Item name="strategyVersionId" label="冠军 / 挑战者策略版本 ID"><Input placeholder="UUID" /></Form.Item>
        </Form>
      </Drawer>

      <Modal title="启动多资产运行" open={runOpen} onCancel={() => setRunOpen(false)} onOk={() => void startRun()} okText="进入队列" confirmLoading={starting}>
        <Typography.Paragraph type="secondary">基于已冻结快照生成调仓计划，并由 TypeScript 权威引擎撮合。</Typography.Paragraph>
        <Typography.Text strong>初始资金</Typography.Text>
        <InputNumber min={10_000} max={1_000_000_000} step={100_000} value={initialCash} onChange={(value) => setInitialCash(Number(value ?? 0))} prefix="¥" style={{ width: '100%', marginTop: 8 }} />
      </Modal>
    </div>
  );
}
