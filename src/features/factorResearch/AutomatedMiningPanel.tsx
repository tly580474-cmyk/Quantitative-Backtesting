import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, App, Button, Dropdown, Form, Input, InputNumber, Modal, Progress, Space, Switch, Table, Tag, Tooltip, Typography } from 'antd';
import { DeleteOutlined, InboxOutlined, MoreOutlined, ReloadOutlined, RollbackOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import {
  approveFactorCandidate, archiveMiningTask, cancelMiningTask, createMiningTask, deleteMiningTask,
  fetchFactorCandidates,
  fetchMiningTasks, freezeFactorCandidate, publishFactorCandidate, rejectFactorCandidate,
  startMiningTask, testFactorCandidate, fetchMiningTaskTrace,
  createMiningSchedule,
  type FactorCandidate, type FactorMiningTask, type MiningEvolutionPoint,
} from './api';

const { Text, Title } = Typography;

function generateRandomSeeds(count = 3): string {
  const seeds = new Set<number>();
  const buffer = new Uint32Array(1);
  while (seeds.size < count) {
    window.crypto.getRandomValues(buffer);
    seeds.add(10_000_000 + (buffer[0] % 90_000_000));
  }
  return [...seeds].join(',');
}

export default function AutomatedMiningPanel() {
  const { message, modal } = App.useApp();
  const [form] = Form.useForm();
  const [tasks, setTasks] = useState<FactorMiningTask[]>([]);
  const [candidates, setCandidates] = useState<FactorCandidate[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string>();
  const [trace, setTrace] = useState<MiningEvolutionPoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [actionId, setActionId] = useState<string>();
  const [approvalCandidate, setApprovalCandidate] = useState<FactorCandidate>();
  const [approvedBy, setApprovedBy] = useState('');
  const [showArchivedTasks, setShowArchivedTasks] = useState(false);

  const refresh = useCallback(async () => {
    const [taskResult, candidateResult] = await Promise.all([
      fetchMiningTasks(30, showArchivedTasks), fetchFactorCandidates(selectedTaskId),
    ]);
    setTasks(taskResult.items);
    setCandidates(candidateResult.items);
  }, [selectedTaskId, showArchivedTasks]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!selectedTaskId) { setTrace([]); return; }
    void fetchMiningTaskTrace(selectedTaskId).then((result) => setTrace(result.items)).catch(() => setTrace([]));
  }, [selectedTaskId, tasks]);
  useEffect(() => {
    if (!tasks.some((task) => task.status === 'running')
      && !candidates.some((candidate) => candidate.status === 'testing')) return;
    const timer = window.setInterval(() => { void refresh(); }, 3000);
    return () => window.clearInterval(timer);
  }, [tasks, candidates, refresh]);

  const runAction = async (id: string, action: () => Promise<unknown>, success: string) => {
    setActionId(id);
    try { await action(); message.success(success); await refresh(); }
    catch (error) { message.error(error instanceof Error ? error.message : '操作失败'); }
    finally { setActionId(undefined); }
  };

  const createAndStart = async (values: { generations: number; population: number;
    sampleSymbols: number; seeds: string; scheduleOnSnapshot: boolean;
    maxMemoryMb: number; timeoutMinutes: number }) => {
    setLoading(true);
    try {
      const seeds = values.seeds.split(',').map(Number).filter(Number.isInteger);
      const config = {
        data: { sample_symbols: values.sampleSymbols },
        evolution: { population_size: values.population, generations: values.generations },
        robustness: { search_seeds: seeds },
        resources: { maxMemoryMb: values.maxMemoryMb, timeoutMs: values.timeoutMinutes * 60_000 },
      };
      const result = await createMiningTask({
        totalGenerations: values.generations * Math.max(1, seeds.length),
        config,
      });
      await startMiningTask(result.task.id);
      if (values.scheduleOnSnapshot) {
        await createMiningSchedule({ name: '快照更新自动挖掘',
          totalGenerations: values.generations * Math.max(1, seeds.length), config });
      }
      setSelectedTaskId(result.task.id);
      message.success('自动挖掘任务已启动');
      await refresh();
    } catch (error) { message.error(error instanceof Error ? error.message : '任务启动失败'); }
    finally { setLoading(false); }
  };

  const testCandidate = (candidate: FactorCandidate) => {
    const split = candidate.sourceLineage.splits as Record<string, { start?: string; end?: string }> | undefined;
    const range = split?.test;
    if (!range?.start || !range.end) {
      message.error('候选血缘中缺少锁定测试区间'); return;
    }
    modal.confirm({
      title: '执行一次锁定测试？',
      content: `区间 ${range.start} 至 ${range.end}。执行后不可回到 frozen 状态。`,
      okText: '执行锁定测试', cancelText: '取消',
      onOk: () => runAction(candidate.id, () => testFactorCandidate(candidate.id, {
        startDate: range.start!, endDate: range.end!, horizonDays: 5, layers: 5,
      }), '锁定测试已启动，完成后会自动更新'),
    });
  };

  const updateTaskArchive = (task: FactorMiningTask, archived: boolean) => runAction(
    task.id,
    async () => {
      await archiveMiningTask(task.id, archived);
      if (selectedTaskId === task.id) setSelectedTaskId(undefined);
    },
    archived ? '任务已归档' : '任务已恢复到列表',
  );

  const confirmTaskDelete = (task: FactorMiningTask) => modal.confirm({
    title: '删除挖掘任务？',
    content: '任务将从列表移除；候选、锁定测试和审批审计仍会保留。此操作不可在界面中恢复。',
    okText: '确认删除', cancelText: '取消', okButtonProps: { danger: true },
    onOk: () => runAction(task.id, async () => {
      await deleteMiningTask(task.id);
      if (selectedTaskId === task.id) setSelectedTaskId(undefined);
    }, '任务已删除'),
  });

  const candidateColumns: ColumnsType<FactorCandidate> = useMemo(() => [
    { title: '候选', dataIndex: 'name', width: 150 },
    { title: '状态', dataIndex: 'status', width: 90, render: (status) => <CandidateStatus status={status} /> },
    { title: '方向', dataIndex: 'direction', width: 110 },
    { title: '公式', dataIndex: 'formula', ellipsis: true, render: (value) => <Text code>{value}</Text> },
    { title: '依赖', dataIndex: 'dependencies', width: 150, ellipsis: true,
      render: (value: string[]) => value.join(', ') },
    { title: '预热', dataIndex: 'warmupDays', width: 70, render: (value) => `${value} 日` },
    { title: '复杂度', width: 80, render: (_, row) => `${metric(row.validationMetrics, 'complexity_nodes')} 节点` },
    { title: '验证 RankIC', width: 110,
      sorter: (left, right, order) => compareMetric(
        left.validationMetrics, right.validationMetrics, 'test_rankic', order),
      sortDirections: ['descend', 'ascend'],
      render: (_, row) => metric(row.validationMetrics, 'test_rankic') },
    { title: '锁定 RankIC', width: 110,
      sorter: (left, right, order) => compareMetric(
        left.lockedTestMetrics, right.lockedTestMetrics, 'averageRankIc', order),
      sortDirections: ['descend', 'ascend'],
      render: (_, row) => metric(row.lockedTestMetrics, 'averageRankIc') },
    { title: '压力夏普', width: 100, render: (_, row) => nestedMetric(row.lockedTestMetrics, 'portfolio', 'stressedCostSharpe') },
    { title: '正式因子相关', width: 110, render: (_, row) => metric(row.lockedTestMetrics, 'maxPublishedFactorCorrelation') },
    { title: '规模/流动性暴露', width: 150, render: (_, row) => `${nestedMetric(row.lockedTestMetrics,
      'robustness', 'sizeExposure')} / ${nestedMetric(row.lockedTestMetrics, 'robustness', 'liquidityExposure')}` },
    { title: '失败原因', dataIndex: 'rejectionReason', width: 180, ellipsis: true,
      render: (value) => value ? <Tooltip title={value}><span>{value}</span></Tooltip> : '—' },
    { title: '操作', width: 290, fixed: 'right', render: (_, row) => (
      <Space wrap>
        {row.status === 'draft' && <Button loading={actionId === row.id} onClick={() => void runAction(
          row.id, () => freezeFactorCandidate(row.id), '候选已冻结')}>冻结</Button>}
        {row.status === 'frozen' && <Button type="primary" loading={actionId === row.id}
          onClick={() => testCandidate(row)}>锁定测试</Button>}
        {row.status === 'tested' && <Button type="primary" loading={actionId === row.id}
          onClick={() => { setApprovalCandidate(row); setApprovedBy(''); }}>提交批准</Button>}
        {row.status === 'approved' && !row.publishedFactorVersionId && <Button type="primary"
          loading={actionId === row.id} onClick={() => modal.confirm({
            title: '发布正式因子版本？', content: '发布后该因子会进入正式因子目录，此操作保留完整审批记录。',
            okText: '确认发布', cancelText: '取消',
            onOk: () => runAction(row.id, () => publishFactorCandidate(row.id), '正式因子版本已发布'),
          })}>发布</Button>}
        {['draft', 'frozen', 'tested'].includes(row.status) && <Button danger onClick={() => modal.confirm({
          title: '拒绝候选？', content: '该状态不可恢复。', okText: '拒绝', okButtonProps: { danger: true },
          onOk: () => runAction(row.id, () => rejectFactorCandidate(row.id, '研究人员在候选审查页拒绝'), '候选已拒绝'),
        })}>拒绝</Button>}
      </Space>
    ) },
  ], [actionId, modal]);

  return (
    <div className="factor-automated-mining">
      <Alert type="info" showIcon title="自动挖掘只生成候选，不会自动上线"
        description="训练和验证用于搜索；锁定测试只执行一次；通过硬门槛后仍需人工批准并单独发布。" />
      <div className="factor-chart-grid" style={{ marginTop: 16 }}>
        <section className="factor-chart-box">
          <Title level={4}>新建挖掘任务</Title>
          <Form form={form} layout="vertical" initialValues={{ generations: 40, population: 300,
            sampleSymbols: 500, seeds: '20260710,20260711,20260712', scheduleOnSnapshot: false,
            maxMemoryMb: 4096, timeoutMinutes: 240 }} onFinish={createAndStart}>
            <div className="factor-form-grid">
              <Form.Item name="generations" label="每种子代数" rules={[{ required: true }]}>
                <InputNumber min={2} max={1000} style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item name="population" label="种群规模" rules={[{ required: true }]}>
                <InputNumber min={20} max={5000} style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item name="sampleSymbols" label="股票池抽样" rules={[{ required: true }]}>
                <InputNumber min={20} max={6000} style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item name="maxMemoryMb" label="内存上限" rules={[{ required: true }]}>
                <InputNumber min={256} max={32768} suffix="MB" style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item name="timeoutMinutes" label="最长运行" rules={[{ required: true }]}>
                <InputNumber min={1} max={1440} suffix="分钟" style={{ width: '100%' }} />
              </Form.Item>
            </div>
            <Form.Item label="随机种子（逗号分隔）" required>
              <Space.Compact block>
                <Form.Item name="seeds" noStyle rules={[{ required: true, message: '请输入或生成随机种子' }]}>
                  <Input aria-label="随机种子" />
                </Form.Item>
                <Button
                  icon={<ReloadOutlined />}
                  aria-label="随机生成种子"
                  onClick={() => form.setFieldValue('seeds', generateRandomSeeds())}
                >
                  随机生成
                </Button>
              </Space.Compact>
            </Form.Item>
            <Form.Item name="scheduleOnSnapshot" label="新快照发布后自动创建新实验" valuePropName="checked">
              <Switch aria-label="新快照自动挖掘" />
            </Form.Item>
            <Button type="primary" htmlType="submit" loading={loading}>创建并启动</Button>
          </Form>
        </section>
        <section className="factor-chart-box">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <Title level={4}>任务进度</Title>
            <Space size={6}>
              <Text type="secondary">显示归档</Text>
              <Switch size="small" checked={showArchivedTasks} aria-label="显示归档任务"
                onChange={setShowArchivedTasks} />
            </Space>
          </div>
          <Table rowKey="id" size="small" pagination={{ pageSize: 5 }} dataSource={tasks}
            onRow={(task) => ({ onClick: () => setSelectedTaskId(task.id), style: { cursor: 'pointer' } })}
            columns={[
              { title: '任务', dataIndex: 'id', render: (value) => String(value).slice(0, 8) },
              { title: '状态', dataIndex: 'status', render: (value, task) => <Space size={4}>
                <Tag>{value}</Tag>{task.archivedAt && <Tag color="default">已归档</Tag>}
              </Space> },
              { title: '进度', render: (_, task) => <Progress size="small" percent={Math.min(100,
                Math.round(task.completedGenerations / Math.max(1, task.totalGenerations) * 100))} /> },
              { title: '操作', width: 120, render: (_, task) => <Space size={4}>
                {task.status === 'running' && <Button danger size="small" onClick={(event) => {
                  event.stopPropagation(); void runAction(task.id, () => cancelMiningTask(task.id), '任务已取消');
                }}>取消</Button>}
                {!task.archivedAt && ['failed', 'canceled'].includes(task.status) && <Button size="small" onClick={(event) => {
                  event.stopPropagation(); void runAction(task.id, () => startMiningTask(task.id, true), '任务已恢复');
                }}>恢复</Button>}
                {['completed', 'failed', 'canceled'].includes(task.status) && <Dropdown trigger={['click']} menu={{
                  onClick: ({ key, domEvent }) => {
                    domEvent.stopPropagation();
                    if (key === 'archive') void updateTaskArchive(task, true);
                    if (key === 'restore') void updateTaskArchive(task, false);
                    if (key === 'delete') confirmTaskDelete(task);
                  },
                  items: [
                    task.archivedAt
                      ? { key: 'restore', icon: <RollbackOutlined />, label: '取消归档' }
                      : { key: 'archive', icon: <InboxOutlined />, label: '归档' },
                    { type: 'divider' },
                    { key: 'delete', icon: <DeleteOutlined />, label: '删除', danger: true },
                  ],
                }}>
                  <Button size="small" icon={<MoreOutlined />} aria-label={`任务 ${task.id.slice(0, 8)} 更多操作`}
                    loading={actionId === task.id} onClick={(event) => event.stopPropagation()} />
                </Dropdown>}
              </Space> },
            ]} />
          {selectedTaskId && <Table rowKey={(row, index) => `${row.seed ?? 'seed'}-${row.generation}-${index}`}
            size="small" pagination={{ pageSize: 5 }} dataSource={trace} locale={{ emptyText: '任务运行后显示进化轨迹' }}
            columns={[
              { title: '种子', dataIndex: 'seed' }, { title: '代', dataIndex: 'generation' },
              { title: '训练', dataIndex: 'best_train_fitness', render: (value) => decimalText(value) },
              { title: '验证', dataIndex: 'best_val_fitness', render: (value) => decimalText(value) },
              { title: '多样性', dataIndex: 'diversity', render: (value) => decimalText(value) },
              { title: '复杂度', dataIndex: 'avg_complexity', render: (value) => decimalText(value) },
            ]} />}
        </section>
      </div>
      <section className="factor-chart-box" style={{ marginTop: 16 }}>
        <Space style={{ marginBottom: 12 }}><Title level={4} style={{ margin: 0 }}>候选审查</Title>
          {selectedTaskId && <Tag color="blue">任务 {selectedTaskId.slice(0, 8)}</Tag>}</Space>
        <Table rowKey="id" size="small" scroll={{ x: 1100 }} columns={candidateColumns}
          dataSource={candidates} pagination={{ pageSize: 10 }} />
      </section>
      <Modal title="人工批准" open={Boolean(approvalCandidate)} okText="确认批准" cancelText="取消"
        okButtonProps={{ disabled: !approvedBy.trim(), loading: actionId === approvalCandidate?.id }}
        onCancel={() => setApprovalCandidate(undefined)} onOk={() => {
          if (!approvalCandidate) return;
          void runAction(approvalCandidate.id,
            () => approveFactorCandidate(approvalCandidate.id, approvedBy), '候选已批准')
            .then(() => setApprovalCandidate(undefined));
        }}>
        <Alert type="warning" showIcon title="批准不等于发布" description="系统会再次校验锁定测试硬门槛；批准后仍需单独点击发布。" />
        {approvalCandidate && <div style={{ marginTop: 16, display: 'grid', gap: 8 }}>
          <Text><Text strong>公式：</Text><Text code>{approvalCandidate.formula}</Text></Text>
          <Text><Text strong>方向：</Text>{approvalCandidate.direction}</Text>
          <Text><Text strong>依赖：</Text>{approvalCandidate.dependencies.join(', ')}</Text>
          <Text><Text strong>预热：</Text>{approvalCandidate.warmupDays} 日</Text>
          <Text><Text strong>锁定 RankIC：</Text>{metric(approvalCandidate.lockedTestMetrics, 'averageRankIc')}</Text>
          <Text><Text strong>双倍成本夏普：</Text>{nestedMetric(approvalCandidate.lockedTestMetrics,
            'portfolio', 'stressedCostSharpe')}</Text>
          <Text><Text strong>最相关正式因子：</Text>{String(
            approvalCandidate.lockedTestMetrics?.closestPublishedFactorId ?? 'N/A')}（{
            metric(approvalCandidate.lockedTestMetrics, 'maxPublishedFactorCorrelation')}）</Text>
        </div>}
        <Input style={{ marginTop: 16 }} value={approvedBy} onChange={(event) => setApprovedBy(event.target.value)}
          placeholder="输入审批人姓名或账号" aria-label="审批人" />
      </Modal>
    </div>
  );
}

function CandidateStatus({ status }: { status: FactorCandidate['status'] }) {
  const color = { draft: 'default', frozen: 'blue', testing: 'processing', tested: 'gold', rejected: 'error', approved: 'success' }[status];
  const text = { draft: '草稿', frozen: '已冻结', testing: '测试中', tested: '已测试', rejected: '已拒绝', approved: '已批准' }[status];
  return <Tag color={color}>{text}</Tag>;
}

function metric(metrics: Record<string, unknown> | null | undefined, key: string) {
  const value = metricValue(metrics, key);
  return value === null ? 'N/A' : value.toFixed(4);
}

function metricValue(metrics: Record<string, unknown> | null | undefined, key: string): number | null {
  if (metrics?.[key] === null || metrics?.[key] === undefined || metrics?.[key] === '') return null;
  const value = Number(metrics[key]);
  return Number.isFinite(value) ? value : null;
}

function compareMetric(
  left: Record<string, unknown> | null | undefined,
  right: Record<string, unknown> | null | undefined,
  key: string,
  order?: 'ascend' | 'descend' | null,
): number {
  const leftValue = metricValue(left, key);
  const rightValue = metricValue(right, key);
  if (leftValue === null && rightValue === null) return 0;
  if (leftValue === null) return order === 'descend' ? -1 : 1;
  if (rightValue === null) return order === 'descend' ? 1 : -1;
  return leftValue - rightValue;
}

function nestedMetric(metrics: Record<string, unknown> | null | undefined, group: string, key: string) {
  const nested = metrics?.[group];
  return metric(nested && typeof nested === 'object' ? nested as Record<string, unknown> : undefined, key);
}

function decimalText(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric.toFixed(3) : 'N/A';
}
