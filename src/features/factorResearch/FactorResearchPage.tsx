import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  App,
  Button,
  DatePicker,
  Empty,
  Form,
  InputNumber,
  Select,
  Space,
  Table,
  Tag,
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
import {
  fetchFactorRuns,
  fetchFactors,
  runFactorResearch,
  type DailyFactorMetric,
  type FactorCatalogItem,
  type FactorReport,
  type FactorRunRequest,
  type FactorRunSummary,
  type LayerMetric,
} from './api';

const { RangePicker } = DatePicker;
const { Text, Title } = Typography;

const DEFAULT_RANGE: [dayjs.Dayjs, dayjs.Dayjs] = [
  dayjs('2026-06-01'),
  dayjs('2026-06-30'),
];

type FormValues = {
  factorId: string;
  range: [dayjs.Dayjs, dayjs.Dayjs];
  horizonDays: number;
  layers: number;
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

export default function FactorResearchPage() {
  const { message } = App.useApp();
  const [form] = Form.useForm<FormValues>();
  const [factors, setFactors] = useState<FactorCatalogItem[]>([]);
  const [runs, setRuns] = useState<FactorRunSummary[]>([]);
  const [selectedFactorId, setSelectedFactorId] = useState('momentum_20');
  const [report, setReport] = useState<FactorReport | null>(null);
  const [loadingFactors, setLoadingFactors] = useState(false);
  const [loadingRuns, setLoadingRuns] = useState(false);
  const [running, setRunning] = useState(false);
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

  useEffect(() => {
    form.setFieldsValue({
      factorId: 'momentum_20',
      range: DEFAULT_RANGE,
      horizonDays: 5,
      layers: 5,
      markets: ['SH', 'SZ'],
    });
    void loadFactors();
    void loadRuns();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
      message.success(`因子报告已保存：${result.runId.slice(0, 8)}`);
      await loadRuns();
    } catch (err) {
      setError(err instanceof Error ? err.message : '因子研究运行失败');
    } finally {
      setRunning(false);
    }
  };

  const factorColumns: ColumnsType<FactorCatalogItem> = [
    {
      title: '因子',
      dataIndex: ['definition', 'name'],
      width: 180,
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
      width: 96,
      render: (_, row) => directionLabel(row.definition.direction),
    },
    {
      title: '预热',
      dataIndex: ['definition', 'warmupDays'],
      width: 72,
      render: (value: number) => `${value} 日`,
    },
    {
      title: '依赖字段',
      dataIndex: ['definition', 'dependencies'],
      responsive: ['md'],
      render: (items: string[]) => (
        <Space size={[4, 4]} wrap>
          {items.map((item) => <Tag key={item}>{item}</Tag>)}
        </Space>
      ),
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
      render: (value: string) => <Tag color={value === 'completed' ? 'success' : 'warning'}>{value}</Tag>,
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
          <Button icon={<ReloadOutlined />} onClick={() => { void loadFactors(); void loadRuns(); }}>
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

      <div className="factor-workbench">
        <section className="factor-panel factor-library-panel">
          <div className="factor-panel-head">
            <span><DatabaseOutlined /> 因子库</span>
            <Tag>{factors.length} 个</Tag>
          </div>
          <Table
            rowKey={(row) => row.versionId}
            size="small"
            loading={loadingFactors}
            columns={factorColumns}
            dataSource={factors}
            pagination={false}
            scroll={{ y: 360 }}
          />
        </section>

        <section className="factor-panel factor-config-panel">
          <div className="factor-panel-head">
            <span><CalculatorOutlined /> 运行配置</span>
            {selectedFactor && <Tag color="blue">{selectedFactor.versionId}</Tag>}
          </div>
          <Form
            form={form}
            layout="vertical"
            onFinish={handleRun}
            className="factor-run-form"
          >
            <Form.Item name="factorId" label="因子" rules={[{ required: true }]}>
              <Select
                options={factors.map((item) => ({
                  value: item.definition.id,
                  label: `${item.definition.name} (${item.definition.id})`,
                }))}
                onChange={setSelectedFactorId}
              />
            </Form.Item>
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
              <Select
                mode="multiple"
                options={[
                  { value: 'SH', label: '沪市' },
                  { value: 'SZ', label: '深市' },
                  { value: 'BJ', label: '北交所' },
                ]}
              />
            </Form.Item>
            <Form.Item name="minDailyAmount" label="成交额下限">
              <InputNumber min={0} step={10000000} suffix="元" />
            </Form.Item>
          </Form>
          {selectedFactor && (
            <div className="factor-definition-note">
              <Text strong>{selectedFactor.definition.name}</Text>
              <Text type="secondary">{selectedFactor.definition.description}</Text>
            </div>
          )}
        </section>

        <section className="factor-panel factor-report-panel">
          <div className="factor-panel-head">
            <span><LineChartOutlined /> 最近报告</span>
            {report && <Tag color="success">{report.summary.tradingDays} 日</Tag>}
          </div>
          {report ? <FactorReportView report={report} /> : <Empty description="暂无报告" />}
        </section>

        <section className="factor-panel factor-history-panel">
          <div className="factor-panel-head">
            <span><BarChartOutlined /> 运行历史</span>
            <Tag>{runs.length} 条</Tag>
          </div>
          <Table
            rowKey="id"
            size="small"
            loading={loadingRuns}
            columns={runColumns}
            dataSource={runs}
            pagination={{ pageSize: 6, size: 'small' }}
          />
        </section>
      </div>
    </div>
  );
}

function FactorReportView({ report }: { report: FactorReport }) {
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
        columns={[
          { title: '日期', dataIndex: 'tradeDate', width: 110 },
          { title: '样本', dataIndex: 'sampleCount', width: 80 },
          { title: 'IC', dataIndex: 'ic', render: (value) => decimal(value) },
          { title: 'Rank IC', dataIndex: 'rankIc', render: (value) => decimal(value) },
        ]}
        dataSource={report.daily}
        pagination={{ pageSize: 5, size: 'small' }}
      />
    </div>
  );
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
