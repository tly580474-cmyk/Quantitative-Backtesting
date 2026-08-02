import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BulbOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  ReloadOutlined,
  StopOutlined,
} from '@ant-design/icons';
import {
  Alert,
  Button,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { getRepository } from '@/api/useRepository';
import type { MarketDataset } from '@/models';
import {
  evaluateHypothesis,
  generateHypotheses,
  hypothesisStatusColor,
  hypothesisStatusLabel,
  listHypotheses,
  rejectHypothesis,
} from './api';
import type { Hypothesis, HypothesisEvaluationRequest } from './types';

const { Text, Title, Paragraph } = Typography;

const DEFAULT_EVALUATION_CONFIG = {
  backtestMode: 'strategy' as const,
  initialCapital: 100_000,
  tradingDays: 250,
  positionSizing: { type: 'percent' as const, value: 0.5 },
  commissionRate: 0.0003,
  minimumCommission: 5,
  sellTaxRate: 0.001,
  slippageBps: 5,
  tradingUnitMode: 'stock' as const,
  minimumTradeAmount: 100,
  dca: { amount: 0, frequency: 'daily' as const },
  execution: 'next_open' as const,
  forceCloseAtEnd: true,
};

export default function HypothesisManagementPage() {
  const [hypotheses, setHypotheses] = useState<Hypothesis[]>([]);
  const [loading, setLoading] = useState(false);
  const [actionId, setActionId] = useState<string | null>(null);
  const [generateOpen, setGenerateOpen] = useState(false);
  const [generateLoading, setGenerateLoading] = useState(false);
  const [generateRejected, setGenerateRejected] = useState<Array<{ name: string; reason: string }>>([]);
  const [evaluateTarget, setEvaluateTarget] = useState<Hypothesis | null>(null);
  const [evaluateLoading, setEvaluateLoading] = useState(false);
  const [rejectTarget, setRejectTarget] = useState<Hypothesis | null>(null);
  const [rejectLoading, setRejectLoading] = useState(false);
  const [datasets, setDatasets] = useState<MarketDataset[]>([]);
  const [selectedDatasetId, setSelectedDatasetId] = useState<string | undefined>();
  const [generateForm] = Form.useForm();
  const [rejectForm] = Form.useForm();

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setHypotheses(await listHypotheses());
    } catch (error) {
      message.error(error instanceof Error ? error.message : '加载假设列表失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const counts = useMemo(() => ({
    total: hypotheses.length,
    draft: hypotheses.filter((item) => item.status === 'draft').length,
    evaluated: hypotheses.filter((item) => item.status === 'evaluated').length,
    rejected: hypotheses.filter((item) => item.status === 'rejected').length,
  }), [hypotheses]);

  const openGenerate = () => {
    generateForm.setFieldsValue({ prompt: '', count: 8 });
    setGenerateRejected([]);
    setGenerateOpen(true);
  };

  const runGenerate = async () => {
    setGenerateLoading(true);
    try {
      const values = await generateForm.validateFields();
      const result = await generateHypotheses({
        prompt: values.prompt || undefined,
        count: values.count,
      });
      setGenerateRejected(result.rejected);
      if (result.hypotheses.length > 0) {
        message.success(`已生成 ${result.hypotheses.length} 条假设`);
        setGenerateOpen(false);
        await refresh();
      } else {
        message.warning('生成的假设均未通过能力边界校验');
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : '假设生成失败');
    } finally {
      setGenerateLoading(false);
    }
  };

  const openEvaluate = async (hypothesis: Hypothesis) => {
    setEvaluateTarget(hypothesis);
    setSelectedDatasetId(undefined);
    try {
      setDatasets(await getRepository().getDatasets());
    } catch {
      setDatasets([]);
      message.error('读取数据集失败');
    }
  };

  const runEvaluate = async () => {
    if (!evaluateTarget) return;
    if (!selectedDatasetId) {
      message.warning('请选择数据集');
      return;
    }
    setEvaluateLoading(true);
    try {
      const dataset = datasets.find((item) => item.id === selectedDatasetId);
      if (!dataset) throw new Error('数据集不存在');
      const stored = await getRepository().getCandlesByDataset(dataset.id);
      if (stored.length < 2) throw new Error('数据集蜡烛数据不足（至少 2 根）');
      const request: HypothesisEvaluationRequest = {
        datasetSnapshot: {
          id: dataset.id,
          name: dataset.name,
          symbol: dataset.symbol,
          startTime: dataset.startTime,
          endTime: dataset.endTime,
          checksum: dataset.checksum,
        },
        candles: stored.map((candle) => ({
          time: candle.time,
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
          volume: candle.volume,
        })),
        config: DEFAULT_EVALUATION_CONFIG,
      };
      await evaluateHypothesis(evaluateTarget.id, request);
      message.success('假设评估完成（筛选层结果，权威复算请走实验报告中心）');
      setEvaluateTarget(null);
      await refresh();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '假设评估失败');
    } finally {
      setEvaluateLoading(false);
    }
  };

  const openReject = (hypothesis: Hypothesis) => {
    setRejectTarget(hypothesis);
    rejectForm.setFieldsValue({ reason: '' });
  };

  const runReject = async () => {
    if (!rejectTarget) return;
    setRejectLoading(true);
    try {
      const values = await rejectForm.validateFields();
      await rejectHypothesis(rejectTarget.id, values.reason);
      message.success('假设已拒绝');
      setRejectTarget(null);
      await refresh();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '拒绝假设失败');
    } finally {
      setRejectLoading(false);
    }
  };

  const columns: ColumnsType<Hypothesis> = [
    {
      title: '假设',
      dataIndex: 'name',
      width: 260,
      render: (_, record) => (
        <div>
          <div><Text strong>{record.plan.name}</Text></div>
          <Text type="secondary" style={{ fontSize: 12 }}>{record.plan.description}</Text>
        </div>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (status: Hypothesis['status'], record) => (
        <Space direction="vertical" size={2}>
          <Tag color={hypothesisStatusColor(status)}>{hypothesisStatusLabel(status)}</Tag>
          {status === 'evaluated' && record.validationStatus && (
            <Tag color={record.validationStatus === 'candidate' ? 'success' : record.validationStatus === 'rejected' ? 'error' : 'warning'}>
              {record.validationStatus === 'candidate' ? '校验候选' : record.validationStatus === 'rejected' ? '校验拒绝' : '待校验'}
            </Tag>
          )}
        </Space>
      ),
    },
    {
      title: '策略',
      dataIndex: 'strategy',
      width: 160,
      render: (_, record) => {
        const params = record.plan.params as { fast?: number; slow?: number };
        return (
          <Tag>{record.plan.strategyType} {params.fast}/{params.slow}</Tag>
        );
      },
    },
    {
      title: '评估摘要',
      dataIndex: 'evaluationSummary',
      width: 220,
      render: (summary: Hypothesis['evaluationSummary']) => summary
        ? (
          <Space direction="vertical" size={2}>
            <Text>收益 <Text type={summary.totalReturn >= 0 ? 'danger' : 'success'}>
              {(summary.totalReturn * 100).toFixed(2)}%
            </Text></Text>
            <Text type="secondary" style={{ fontSize: 12 }}>
              终值 {summary.finalEquity.toFixed(0)} · {summary.tradeCount} 笔 · 筛选层
            </Text>
          </Space>
        )
        : <Text type="secondary">—</Text>,
    },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      width: 170,
      render: (value: string) => new Date(value).toLocaleString('zh-CN', { hour12: false }),
    },
    {
      title: '操作',
      key: 'actions',
      width: 150,
      render: (_, record) => {
        if (record.status === 'draft') {
          return (
            <Space>
              <Button
                size="small"
                type="primary"
                icon={<PlayCircleOutlined />}
                loading={actionId === record.id}
                onClick={async () => {
                  setActionId(record.id);
                  await openEvaluate(record);
                  setActionId(null);
                }}
              >
                评估
              </Button>
              <Button
                size="small"
                danger
                icon={<StopOutlined />}
                onClick={() => openReject(record)}
              >
                拒绝
              </Button>
            </Space>
          );
        }
        if (record.status === 'rejected') {
          return <Text type="secondary" style={{ fontSize: 12 }}>{record.rejectionReason}</Text>;
        }
        return (
          <Text type="secondary" style={{ fontSize: 12 }}>
            v{record.plan.capabilityVersion.slice(0, 8)}
          </Text>
        );
      },
    },
  ];

  return (
    <div className="factor-page factor-section-page">
      <header className="factor-page-head">
        <div>
          <Text type="secondary">研究 Agent · 假设生成</Text>
          <Title level={2}><BulbOutlined /> 假设研究</Title>
        </div>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={() => void refresh()}>刷新</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={openGenerate}>生成假设</Button>
        </Space>
      </header>

      <section className="factor-panel factor-section-panel">
        <div style={{ marginBottom: 12 }}>
          <Space wrap>
            <Tag>共 {counts.total}</Tag>
            <Tag color="default">草稿 {counts.draft}</Tag>
            <Tag color="success">已评估 {counts.evaluated}</Tag>
            <Tag color="error">已拒绝 {counts.rejected}</Tag>
          </Space>
        </div>
        <Table<Hypothesis>
          rowKey="id"
          loading={loading}
          columns={columns}
          dataSource={hypotheses}
          pagination={{ pageSize: 10, showSizeChanger: false }}
          size="middle"
        />
      </section>

      <Modal
        title="生成研究假设"
        open={generateOpen}
        onCancel={() => setGenerateOpen(false)}
        onOk={() => void runGenerate()}
        confirmLoading={generateLoading}
        okText="生成"
      >
        <Paragraph type="secondary">
          由 LLM 基于能力清单（事件引擎白名单策略 + 因子库 + 指标注册表）生成可检验的研究假设；
          越界假设会被能力边界校验拒绝，不会进入列表。
        </Paragraph>
        <Form form={generateForm} layout="vertical">
          <Form.Item name="prompt" label="研究方向（可选）">
            <Input.TextArea
              rows={3}
              placeholder="例如：观察 A 股日线趋势跟踪在短周期均线下的表现"
            />
          </Form.Item>
          <Form.Item name="count" label="生成条数" rules={[{ required: true }]}>
            <InputNumber min={1} max={20} style={{ width: 120 }} />
          </Form.Item>
        </Form>
        {generateRejected.length > 0 && (
          <Alert
            type="warning"
            showIcon
            message={`${generateRejected.length} 条假设未通过能力边界校验`}
            description={generateRejected.map((item) => `${item.name}: ${item.reason}`).join('；')}
          />
        )}
      </Modal>

      <Modal
        title={`评估假设：${evaluateTarget?.plan.name ?? ''}`}
        open={evaluateTarget !== null}
        onCancel={() => setEvaluateTarget(null)}
        onOk={() => void runEvaluate()}
        confirmLoading={evaluateLoading}
        okText="开始评估"
        width={520}
      >
        <Paragraph type="secondary">
          选择本地数据集后，后端将通过 backtrader 事件引擎批量回测（筛选层，ADR-05），
          并复用 M2 幂等运行流程生成实验版本与校验报告。
        </Paragraph>
        <Form layout="vertical">
          <Form.Item label="数据集" required>
            <Select
              placeholder="选择数据集"
              value={selectedDatasetId}
              onChange={setSelectedDatasetId}
              options={datasets.map((dataset) => ({
                value: dataset.id,
                label: `${dataset.name}（${dataset.symbol} · ${dataset.count} 根）`,
              }))}
            />
          </Form.Item>
          <Form.Item label="评估配置">
            <Text type="secondary" style={{ fontSize: 12 }}>
              初始资金 {DEFAULT_EVALUATION_CONFIG.initialCapital.toLocaleString()} · 仓位 50% ·
              佣金 0.03% · 滑点 5bp · 印花税 0.1% · 期末强平
            </Text>
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={`拒绝假设：${rejectTarget?.plan.name ?? ''}`}
        open={rejectTarget !== null}
        onCancel={() => setRejectTarget(null)}
        onOk={() => void runReject()}
        confirmLoading={rejectLoading}
        okText="确认拒绝"
        okButtonProps={{ danger: true }}
      >
        <Form form={rejectForm} layout="vertical">
          <Form.Item name="reason" label="拒绝理由" rules={[{ required: true, message: '请填写拒绝理由' }]}>
            <Input.TextArea rows={3} placeholder="例如：该参数组合与前 20 日动量高度相关，缺乏增量信息" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
