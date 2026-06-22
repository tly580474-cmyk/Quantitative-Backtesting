import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Tabs,
  Table,
  Card,
  Row,
  Col,
  Statistic,
  Button,
  Input,
  Select,
  Tag,
  Badge,
  Progress,
  Popover,
  Popconfirm,
  Space,
  Typography,
  Spin,
  Empty,
  App,
} from 'antd';
import {
  SyncOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  WarningOutlined,
  ReloadOutlined,
  SearchOutlined,
  EyeOutlined,
  ExperimentOutlined,
  QuestionCircleOutlined,
} from '@ant-design/icons';
import { apiFetch } from '../../api/client';
import { useCandleStore } from '../../stores/useCandleStore';
import CreateSyncModal from './CreateSyncModal';
import DataQualityModal from './DataQualityModal';
import type { Instrument, DataFreshness, SyncJob, DataQualityIssue, SyncJobItem } from './types';
import type { ColumnsType } from 'antd/es/table';

const { Text, Title } = Typography;
const PAGE_SIZE = 50;

const MARKET_OPTIONS = [
  { label: '全部', value: '' },
  { label: '沪市', value: 'SH' },
  { label: '深市', value: 'SZ' },
  { label: '京市', value: 'BJ' },
];

const TYPE_OPTIONS = [
  { label: '全部', value: '' },
  { label: '股票', value: 'stock' },
  { label: '指数', value: 'index' },
  { label: 'ETF', value: 'etf' },
];

const SEVERITY_OPTIONS = [
  { label: '全部', value: '' },
  { label: '阻断', value: 'blocked' },
  { label: '警告', value: 'warning' },
  { label: '通过', value: 'pass' },
];

const ISSUE_STATUS_OPTIONS = [
  { label: '全部', value: '' },
  { label: '待处理', value: 'open' },
  { label: '已确认', value: 'confirmed' },
  { label: '已忽略', value: 'ignored' },
  { label: '已解决', value: 'resolved' },
];

function statusTag(status: string) {
  const map: Record<string, { color: string; text: string }> = {
    active: { color: 'green', text: '正常' },
    delisted: { color: 'red', text: '已退市' },
    suspended: { color: 'orange', text: '停牌' },
  };
  const entry = map[status] ?? { color: 'default', text: status };
  return <Tag color={entry.color}>{entry.text}</Tag>;
}

function qualityTag(qs: string | undefined) {
  if (!qs) return <Tag>未知</Tag>;
  const map: Record<string, { color: string; text: string; icon: React.ReactNode }> = {
    pass: { color: 'green', text: '通过', icon: <CheckCircleOutlined /> },
    warning: { color: 'orange', text: '警告', icon: <WarningOutlined /> },
    blocked: { color: 'red', text: '阻断', icon: <CloseCircleOutlined /> },
  };
  const entry = map[qs] ?? { color: 'default', text: qs, icon: null };
  return (
    <Tag color={entry.color} icon={entry.icon}>
      {entry.text}
    </Tag>
  );
}

function severityTag(severity: string) {
  const map: Record<string, { color: string; text: string; icon: React.ReactNode }> = {
    blocked: { color: 'red', text: '阻断', icon: <CloseCircleOutlined /> },
    warning: { color: 'orange', text: '警告', icon: <WarningOutlined /> },
    pass: { color: 'green', text: '通过', icon: <CheckCircleOutlined /> },
  };
  const entry = map[severity] ?? { color: 'default', text: severity, icon: null };
  return (
    <Tag color={entry.color} icon={entry.icon}>
      {entry.text}
    </Tag>
  );
}

function issueStatusTag(status: string) {
  const map: Record<string, { color: string; text: string }> = {
    open: { color: 'blue', text: '待处理' },
    confirmed: { color: 'cyan', text: '已确认' },
    ignored: { color: 'default', text: '已忽略' },
    resolved: { color: 'green', text: '已解决' },
  };
  const entry = map[status] ?? { color: 'default', text: status };
  return <Tag color={entry.color}>{entry.text}</Tag>;
}

function jobTypeTag(jobType: string) {
  const map: Record<string, { color: string; text: string }> = {
    instruments: { color: 'blue', text: '证券同步' },
    calendars: { color: 'cyan', text: '日历同步' },
    history: { color: 'purple', text: '历史回补' },
    incremental: { color: 'green', text: '增量更新' },
  };
  const entry = map[jobType] ?? { color: 'default', text: jobType };
  return <Tag color={entry.color}>{entry.text}</Tag>;
}

function jobStatusBadge(status: string) {
  const map: Record<string, 'default' | 'processing' | 'success' | 'error' | 'warning'> = {
    pending: 'default',
    running: 'processing',
    completed: 'success',
    failed: 'error',
    cancelled: 'warning',
  };
  const statusMap: Record<string, string> = {
    pending: '等待中',
    running: '运行中',
    completed: '已完成',
    failed: '失败',
    cancelled: '已取消',
  };
  return <Badge status={map[status] ?? 'default'} text={statusMap[status] ?? status} />;
}

function itemStatusTag(status: string) {
  const map: Record<string, { color: string; text: string }> = {
    pending: { color: 'default', text: '等待中' },
    running: { color: 'processing', text: '运行中' },
    completed: { color: 'success', text: '已完成' },
    failed: { color: 'error', text: '失败' },
    skipped: { color: 'warning', text: '跳过' },
  };
  const entry = map[status] ?? { color: 'default', text: status };
  return <Tag color={entry.color}>{entry.text}</Tag>;
}

export default function MarketDataPage() {
  const navigate = useNavigate();
  const { message: msgApi, modal: modalApi } = App.useApp();
  const setCandles = useCandleStore((s) => s.setCandles);
  const setImportResult = useCandleStore((s) => s.setImportResult);

  // ---- Freshness ----
  const [freshness, setFreshness] = useState<DataFreshness | null>(null);
  const [freshnessLoading, setFreshnessLoading] = useState(false);
  const [freshnessFetchedAt, setFreshnessFetchedAt] = useState<string>('');
  const [providers, setProviders] = useState<Array<{ id: string; name: string; type: string }>>([]);

  // ---- Instruments tab ----
  const [instruments, setInstruments] = useState<Instrument[]>([]);
  const [instrumentsTotal, setInstrumentsTotal] = useState(0);
  const [instrumentsLoading, setInstrumentsLoading] = useState(false);
  const [instrumentSearch, setInstrumentSearch] = useState('');
  const [instrumentMarket, setInstrumentMarket] = useState('');
  const [instrumentType, setInstrumentType] = useState('');
  const [instrumentPage, setInstrumentPage] = useState(1);

  // ---- Sync Jobs tab ----
  const [syncJobs, setSyncJobs] = useState<SyncJob[]>([]);
  const [syncJobsTotal, setSyncJobsTotal] = useState(0);
  const [syncJobsLoading, setSyncJobsLoading] = useState(false);
  const [syncJobsPage, setSyncJobsPage] = useState(1);
  const [expandedJobIds, setExpandedJobIds] = useState<string[]>([]);
  const [jobItemsCache, setJobItemsCache] = useState<Record<string, SyncJobItem[]>>({});
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ---- Data Quality tab ----
  const [qualityIssues, setQualityIssues] = useState<DataQualityIssue[]>([]);
  const [qualityTotal, setQualityTotal] = useState(0);
  const [qualityLoading, setQualityLoading] = useState(false);
  const [qualitySeverity, setQualitySeverity] = useState('');
  const [qualityStatus, setQualityStatus] = useState('');
  const [qualityPage, setQualityPage] = useState(1);

  // ---- Modals ----
  const [createSyncModal, setCreateSyncModal] = useState<{
    open: boolean;
    jobType: 'instruments' | 'calendars' | 'history' | 'incremental';
  }>({ open: false, jobType: 'instruments' });
  const [qualityModalOpen, setQualityModalOpen] = useState(false);

  // ---- Active tab ----
  const [activeTab, setActiveTab] = useState('instruments');

  // ==================== Data Fetching ====================

  const fetchFreshness = useCallback(async () => {
    setFreshnessLoading(true);
    try {
      const [data, providerList] = await Promise.all([
        apiFetch<DataFreshness>('/api/market-data/freshness'),
        apiFetch<Array<{ id: string; name: string; type: string }>>('/api/market-data/providers').catch(() => [] as Array<{ id: string; name: string; type: string }>),
      ]);
      setFreshness(data);
      setProviders(providerList);
      setFreshnessFetchedAt(new Date().toLocaleTimeString('zh-CN'));
    } catch {
      msgApi.error('获取数据概览失败');
    } finally {
      setFreshnessLoading(false);
    }
  }, [msgApi]);

  const fetchInstruments = useCallback(
    async (page: number) => {
      setInstrumentsLoading(true);
      const offset = (page - 1) * PAGE_SIZE;
      const params = new URLSearchParams();
      if (instrumentMarket) params.set('market', instrumentMarket);
      if (instrumentType) params.set('type', instrumentType);
      if (instrumentSearch) params.set('symbol', instrumentSearch);
      params.set('offset', String(offset));
      params.set('limit', String(PAGE_SIZE));

      try {
        const data = await apiFetch<{ items: Instrument[]; total: number }>(
          `/api/instruments?${params.toString()}`,
        );
        setInstruments(data.items ?? []);
        setInstrumentsTotal(data.total ?? 0);
      } catch {
        msgApi.error('获取证券列表失败');
      } finally {
        setInstrumentsLoading(false);
      }
    },
    [instrumentMarket, instrumentType, instrumentSearch, msgApi],
  );

  const fetchSyncJobs = useCallback(
    async (page: number, silent = false) => {
      if (!silent) setSyncJobsLoading(true);
      const offset = (page - 1) * PAGE_SIZE;
      try {
        const data = await apiFetch<{ items: SyncJob[]; total: number }>(
          `/api/sync/jobs?offset=${offset}&limit=${PAGE_SIZE}`,
        );
        setSyncJobs(data.items ?? []);
        setSyncJobsTotal(data.total ?? 0);
      } catch {
        if (!silent) msgApi.error('获取同步任务列表失败');
      } finally {
        if (!silent) setSyncJobsLoading(false);
      }
    },
    [msgApi],
  );

  const fetchQualityIssues = useCallback(
    async (page: number) => {
      setQualityLoading(true);
      const offset = (page - 1) * PAGE_SIZE;
      const params = new URLSearchParams();
      if (qualitySeverity) params.set('severity', qualitySeverity);
      if (qualityStatus) params.set('status', qualityStatus);
      params.set('offset', String(offset));
      params.set('limit', String(PAGE_SIZE));

      try {
        const data = await apiFetch<{ items: DataQualityIssue[]; total: number }>(
          `/api/data-quality/issues?${params.toString()}`,
        );
        setQualityIssues(data.items ?? []);
        setQualityTotal(data.total ?? 0);
      } catch {
        msgApi.error('获取数据质量问题列表失败');
      } finally {
        setQualityLoading(false);
      }
    },
    [qualitySeverity, qualityStatus, msgApi],
  );

  // ==================== Effects ====================

  useEffect(() => {
    fetchFreshness();
  }, [fetchFreshness]);

  useEffect(() => {
    if (activeTab === 'instruments') {
      fetchInstruments(instrumentPage);
    }
  }, [activeTab, instrumentPage, fetchInstruments]);

  useEffect(() => {
    if (activeTab === 'syncJobs') {
      fetchSyncJobs(syncJobsPage);
    }
  }, [activeTab, syncJobsPage, fetchSyncJobs]);

  useEffect(() => {
    if (activeTab === 'quality') {
      fetchQualityIssues(qualityPage);
    }
  }, [activeTab, qualityPage, fetchQualityIssues]);

  // Polling for running jobs
  useEffect(() => {
    const hasRunning =
      activeTab === 'syncJobs' &&
      syncJobs.some((j) => j.status === 'running' || j.status === 'pending');

    if (hasRunning && !pollingRef.current) {
      pollingRef.current = setInterval(() => {
        fetchSyncJobs(syncJobsPage, true);
      }, 5000);
    } else if (!hasRunning && pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }

    return () => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
    };
  }, [activeTab, syncJobs, syncJobsPage, fetchSyncJobs]);

  // Reset pagination when filters change
  useEffect(() => {
    setInstrumentPage(1);
  }, [instrumentMarket, instrumentType, instrumentSearch]);

  useEffect(() => {
    setQualityPage(1);
  }, [qualitySeverity, qualityStatus]);

  // ==================== Actions ====================

  const handleViewCandles = async (instrument: Instrument) => {
    try {
      const data = await apiFetch<{ items: Array<Record<string, unknown>> }>(
        `/api/instruments/${instrument.id}/candles?limit=10000`,
      );
      const candleResponse = data as unknown as { data?: Array<Record<string, unknown>> };
      const candles = (candleResponse.data ?? []).map((item) => ({
        time: String(item.tradeDate ?? ''),
        open: Number(item.open ?? 0),
        high: Number(item.high ?? 0),
        low: Number(item.low ?? 0),
        close: Number(item.close ?? 0),
        volume: Number(item.volume ?? 0),
        turnover: Number(item.turnover ?? 0),
      }));
      setCandles(candles as never);
      setImportResult({
        success: true,
        fileName: `${instrument.symbol} - ${instrument.name}`,
        symbol: instrument.symbol,
        dateRange: {
          from: candles[0]?.time ?? '',
          to: candles[candles.length - 1]?.time ?? '',
        },
        totalRows: candles.length,
        validRows: candles.length,
        errors: [],
        warnings: [],
        candles: candles as never,
      });
      navigate('/');
    } catch {
      msgApi.error('获取行情数据失败');
    }
  };

  const handleBacktest = (instrument: Instrument) => {
    setCandles([]);
    setImportResult({
      success: true,
      fileName: `${instrument.symbol} - ${instrument.name}`,
      symbol: instrument.symbol,
      dateRange: { from: instrument.startDate ?? '', to: instrument.endDate ?? '' },
      totalRows: 0,
      validRows: 0,
      errors: [],
      warnings: [],
      candles: [],
    });
    navigate('/backtest');
  };

  // ---- Sync actions ----

  const submitSync = async (jobType: string, payload: Record<string, unknown>) => {
    const endpointMap: Record<string, string> = {
      instruments: '/api/sync/instruments',
      calendars: '/api/sync/calendars',
      history: '/api/sync/history',
      incremental: '/api/sync/incremental',
    };
    try {
      await apiFetch(endpointMap[jobType], {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      msgApi.success('同步任务已提交');
      fetchSyncJobs(1);
    } catch {
      msgApi.error('提交同步任务失败');
    }
  };

  const handleCreateSync = (jobType: 'instruments' | 'calendars' | 'history' | 'incremental') => {
    if (jobType === 'history') {
      // Show inline modal first to collect symbols and date range
      setCreateSyncModal({ open: true, jobType: 'history' });
    } else {
      setCreateSyncModal({ open: true, jobType });
    }
  };

  const handleSyncSubmit = (payload: Record<string, unknown>) => {
    if (createSyncModal.jobType === 'history') {
      const symbols = (payload.symbols as string[]) ?? [];
      const startDate = (payload.startDate as string) ?? '';
      const endDate = (payload.endDate as string) ?? '';
      // Rough estimate: count trading days between dates
      let estimatedDays = 0;
      if (startDate && endDate) {
        const start = new Date(startDate);
        const end = new Date(endDate);
        const diffDays = Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
        estimatedDays = Math.round(diffDays * 0.7); // Approximate trading days (~70% of calendar days)
      }
      const estimatedRequests = symbols.length * Math.max(estimatedDays, 1);

      modalApi.confirm({
        title: '确认历史回补任务',
        icon: <WarningOutlined />,
        content: (
          <div style={{ lineHeight: 2 }}>
            <p>
              <Text strong>证券数量：</Text>
              <Text>{symbols.length} 只</Text>
            </p>
            <p>
              <Text strong>日期范围：</Text>
              <Text>{startDate || '--'} ~ {endDate || '--'}</Text>
            </p>
            <p>
              <Text strong>预估交易日数：</Text>
              <Text>{estimatedDays} 天</Text>
            </p>
            <p>
              <Text strong>预估请求次数：</Text>
              <Text type="danger" style={{ fontSize: 16 }}>
                {estimatedRequests.toLocaleString()} 次
              </Text>
            </p>
            <p style={{ marginTop: 12, color: '#cf1322' }}>
              <WarningOutlined /> 大规模数据回补可能需要较长时间，确认后请在同步任务列表中查看进度。
            </p>
          </div>
        ),
        okText: '确认提交',
        cancelText: '取消',
        width: 480,
        onOk: () => submitSync(createSyncModal.jobType, payload),
      });
    } else {
      submitSync(createSyncModal.jobType, payload);
    }
  };

  const handleCancelJob = async (jobId: string) => {
    try {
      await apiFetch(`/api/sync/jobs/${jobId}/cancel`, { method: 'POST' });
      msgApi.success('已发送取消请求');
      fetchSyncJobs(syncJobsPage, true);
    } catch {
      msgApi.error('取消任务失败');
    }
  };

  const handleRetryJob = async (jobId: string) => {
    try {
      await apiFetch(`/api/sync/jobs/${jobId}/retry`, { method: 'POST' });
      msgApi.success('已重新提交任务');
      fetchSyncJobs(1);
    } catch {
      msgApi.error('重试任务失败');
    }
  };

  const handleExpandJob = async (expanded: boolean, record: SyncJob) => {
    if (expanded) {
      setExpandedJobIds((prev) => [...prev, record.id]);
      if (!jobItemsCache[record.id]) {
        try {
          const data = await apiFetch<SyncJob>(`/api/sync/jobs/${record.id}`);
          setJobItemsCache((prev) => ({
            ...prev,
            [record.id]: (data as SyncJob & { items?: SyncJobItem[] }).items ?? [],
          }));
        } catch {
          msgApi.error('获取任务详情失败');
        }
      }
    } else {
      setExpandedJobIds((prev) => prev.filter((id) => id !== record.id));
    }
  };

  // ---- Quality actions ----

  const handleResolveIssue = async (
    issueId: string,
    resolution: 'confirmed' | 'ignored' | 'resolved',
  ) => {
    try {
      await apiFetch(`/api/data-quality/issues/${issueId}/resolve`, {
        method: 'POST',
        body: JSON.stringify({ resolution }),
      });
      msgApi.success(
        resolution === 'confirmed'
          ? '已确认问题'
          : resolution === 'ignored'
            ? '已忽略问题'
            : '已标记为已解决',
      );
      fetchQualityIssues(qualityPage);
    } catch {
      msgApi.error('操作失败');
    }
  };

  const handleRecheck = (payload: {
    instrumentId?: string;
    startDate?: string;
    endDate?: string;
  }) => {
    apiFetch('/api/data-quality/recheck', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
      .then(() => {
        msgApi.success('已提交重新检查请求');
        fetchQualityIssues(1);
      })
      .catch(() => msgApi.error('提交重新检查失败'));
  };

  // ==================== Table Columns ====================

  const instrumentColumns: ColumnsType<Instrument> = [
    {
      title: '代码',
      dataIndex: 'symbol',
      key: 'symbol',
      width: 100,
      render: (text: string) => <Text code>{text}</Text>,
    },
    {
      title: '名称',
      dataIndex: 'name',
      key: 'name',
      ellipsis: true,
    },
    {
      title: '市场',
      dataIndex: 'market',
      key: 'market',
      width: 80,
    },
    {
      title: '类型',
      dataIndex: 'type',
      key: 'type',
      width: 80,
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 90,
      render: (_: string, r: Instrument) => statusTag(r.status),
    },
    {
      title: '数据范围',
      key: 'dataRange',
      width: 200,
      render: (_: unknown, r: Instrument) => {
        if (!r.startDate && !r.endDate) return <Text type="secondary">暂无数据</Text>;
        return (
          <Text type="secondary" style={{ fontSize: 12 }}>
            {r.startDate ?? '--'} ~ {r.endDate ?? '--'}
          </Text>
        );
      },
    },
    {
      title: '数据质量',
      key: 'qualityStatus',
      width: 100,
      render: (_: unknown, r: Instrument) => qualityTag(r.qualityStatus),
    },
    {
      title: '操作',
      key: 'actions',
      width: 220,
      render: (_: unknown, r: Instrument) => (
        <Space size="small">
          <Button
            type="link"
            size="small"
            icon={<EyeOutlined />}
            onClick={() => handleViewCandles(r)}
          >
            查看行情
          </Button>
          <Button
            type="link"
            size="small"
            icon={<ExperimentOutlined />}
            onClick={() => handleBacktest(r)}
          >
            回测
          </Button>
        </Space>
      ),
    },
  ];

  const syncJobColumns: ColumnsType<SyncJob> = [
    {
      title: '任务类型',
      dataIndex: 'jobType',
      key: 'jobType',
      width: 110,
      render: (t: string) => jobTypeTag(t),
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 100,
      render: (s: string) => jobStatusBadge(s),
    },
    {
      title: '数据源',
      dataIndex: 'providerId',
      key: 'providerId',
      width: 120,
      ellipsis: true,
    },
    {
      title: '进度',
      key: 'progress',
      width: 200,
      render: (_: unknown, r: SyncJob) => {
        const pct = r.totalItems > 0 ? Math.round((r.completedItems / r.totalItems) * 100) : 0;
        return (
          <Space direction="vertical" size={0} style={{ width: '100%' }}>
            <Progress percent={pct} size="small" />
            <Text type="secondary" style={{ fontSize: 11 }}>
              {r.completedItems} / {r.totalItems}
              {r.failedItems > 0 && (
                <Text type="danger" style={{ fontSize: 11 }}>
                  {' '}
                  失败 {r.failedItems}
                </Text>
              )}
            </Text>
          </Space>
        );
      },
    },
    {
      title: '开始时间',
      dataIndex: 'startedAt',
      key: 'startedAt',
      width: 160,
      render: (t: string | undefined) =>
        t ? <Text style={{ fontSize: 12 }}>{t}</Text> : <Text type="secondary">--</Text>,
    },
    {
      title: '完成时间',
      dataIndex: 'finishedAt',
      key: 'finishedAt',
      width: 160,
      render: (t: string | undefined) =>
        t ? <Text style={{ fontSize: 12 }}>{t}</Text> : <Text type="secondary">--</Text>,
    },
    {
      title: '操作',
      key: 'actions',
      width: 160,
      render: (_: unknown, r: SyncJob) => (
        <Space size="small">
          <Button
            type="link"
            size="small"
            onClick={() => {
              const isExpanded = expandedJobIds.includes(r.id);
              handleExpandJob(!isExpanded, r);
            }}
          >
            {expandedJobIds.includes(r.id) ? '收起' : '详情'}
          </Button>
          {(r.status === 'running' || r.status === 'pending') && (
            <Popconfirm
              title="确定取消此任务？"
              onConfirm={() => handleCancelJob(r.id)}
            >
              <Button type="link" size="small" danger>
                取消
              </Button>
            </Popconfirm>
          )}
          {r.status === 'failed' && (
            <Button
              type="link"
              size="small"
              onClick={() => handleRetryJob(r.id)}
            >
              重试
            </Button>
          )}
        </Space>
      ),
    },
  ];

  const jobItemColumns: ColumnsType<SyncJobItem> = [
    { title: '证券ID', dataIndex: 'instrumentId', key: 'instrumentId', width: 200, ellipsis: true },
    { title: '状态', dataIndex: 'status', key: 'status', width: 90, render: (s: string) => itemStatusTag(s) },
    { title: '尝试次数', dataIndex: 'attempts', key: 'attempts', width: 80 },
    {
      title: '错误信息',
      dataIndex: 'errorMessage',
      key: 'errorMessage',
      ellipsis: true,
      render: (t: string | undefined) =>
        t ? <Text type="danger" style={{ fontSize: 12 }}>{t}</Text> : <Text type="secondary">--</Text>,
    },
  ];

  const qualityIssueColumns: ColumnsType<DataQualityIssue> = [
    {
      title: '交易日',
      dataIndex: 'tradeDate',
      key: 'tradeDate',
      width: 110,
    },
    {
      title: '规则代码',
      dataIndex: 'ruleCode',
      key: 'ruleCode',
      width: 120,
      render: (t: string) => <Text code>{t}</Text>,
    },
    {
      title: '严重程度',
      dataIndex: 'severity',
      key: 'severity',
      width: 100,
      render: (s: string) => severityTag(s),
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 90,
      render: (s: string) => issueStatusTag(s),
    },
    {
      title: '详情',
      dataIndex: 'details',
      key: 'details',
      width: 70,
      render: (d: Record<string, unknown> | undefined) =>
        d ? (
          <Popover
            content={
              <pre style={{ maxWidth: 400, maxHeight: 300, overflow: 'auto', fontSize: 12 }}>
                {JSON.stringify(d, null, 2)}
              </pre>
            }
            title="问题详情"
          >
            <Button type="link" size="small" icon={<QuestionCircleOutlined />}>
              查看
            </Button>
          </Popover>
        ) : (
          <Text type="secondary">--</Text>
        ),
    },
    {
      title: '检测时间',
      dataIndex: 'detectedAt',
      key: 'detectedAt',
      width: 160,
      render: (t: string) => <Text style={{ fontSize: 12 }}>{t}</Text>,
    },
    {
      title: '操作',
      key: 'actions',
      width: 200,
      render: (_: unknown, r: DataQualityIssue) => {
        if (r.status === 'resolved') return <Text type="secondary">--</Text>;
        return (
          <Space size="small">
            {r.status === 'open' && (
              <Button
                type="link"
                size="small"
                onClick={() => handleResolveIssue(r.id, 'confirmed')}
              >
                确认
              </Button>
            )}
            {(r.status === 'open' || r.status === 'confirmed') && (
              <Button
                type="link"
                size="small"
                onClick={() => handleResolveIssue(r.id, 'ignored')}
              >
                忽略
              </Button>
            )}
            <Button
              type="link"
              size="small"
              onClick={() => handleResolveIssue(r.id, 'resolved')}
            >
              已解决
            </Button>
          </Space>
        );
      },
    },
  ];

  // ==================== Render ====================

  const renderFreshnessCards = () => (
    <Spin spinning={freshnessLoading}>
      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={12} sm={6}>
          <Card size="small">
            <Statistic
              title="已同步证券数 / 总证券数"
              value={freshness?.syncedInstruments ?? 0}
              suffix={`/ ${freshness?.totalInstruments ?? 0}`}
              valueStyle={{ color: '#1677FF' }}
            />
          </Card>
        </Col>
        <Col xs={12} sm={6}>
          <Card size="small">
            <Statistic
              title="最新交易日"
              value={freshness?.latestTradeDate ?? '--'}
              valueStyle={{
                color: freshness?.latestTradeDate ? '#3f8600' : '#999',
                fontSize: freshness?.latestTradeDate ? 20 : 14,
              }}
            />
          </Card>
        </Col>
        <Col xs={12} sm={6}>
          <Card size="small">
            <Statistic
              title="待补交易日数"
              value={freshness?.pendingTradeDates ?? 0}
              valueStyle={{
                color: (freshness?.pendingTradeDates ?? 0) > 0 ? '#cf1322' : '#3f8600',
              }}
            />
          </Card>
        </Col>
        <Col xs={12} sm={6}>
          <Card size="small">
            <Statistic
              title="待处理质量问题"
              value={freshness?.openIssueCount ?? 0}
              valueStyle={{
                color: (freshness?.openIssueCount ?? 0) > 0 ? '#cf1322' : '#3f8600',
              }}
            />
          </Card>
        </Col>
      </Row>
      {providers.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <Space size="middle" wrap>
            <Text type="secondary">
              数据源：
              {providers.map((p) => (
                <Tag key={p.id} style={{ marginLeft: 4 }}>
                  {p.name} ({p.type})
                </Tag>
              ))}
            </Text>
            {freshnessFetchedAt && (
              <Text type="secondary">最后同步：{freshnessFetchedAt}</Text>
            )}
          </Space>
        </div>
      )}
    </Spin>
  );

  const renderInstrumentsTab = () => (
    <div>
      {renderFreshnessCards()}

      <Card size="small" style={{ marginBottom: 16 }}>
        <Space wrap>
          <Input
            prefix={<SearchOutlined />}
            placeholder="搜索代码或名称"
            value={instrumentSearch}
            onChange={(e) => setInstrumentSearch(e.target.value)}
            style={{ width: 200 }}
            allowClear
            onPressEnter={() => {
              setInstrumentPage(1);
              fetchInstruments(1);
            }}
          />
          <Select
            value={instrumentMarket}
            onChange={setInstrumentMarket}
            options={MARKET_OPTIONS}
            style={{ width: 100 }}
            placeholder="市场"
          />
          <Select
            value={instrumentType}
            onChange={setInstrumentType}
            options={TYPE_OPTIONS}
            style={{ width: 100 }}
            placeholder="类型"
          />
          <Button
            type="primary"
            icon={<SearchOutlined />}
            onClick={() => {
              setInstrumentPage(1);
              fetchInstruments(1);
            }}
          >
            搜索
          </Button>
        </Space>
      </Card>

      <Card size="small">
        <Table<Instrument>
          columns={instrumentColumns}
          dataSource={instruments}
          rowKey="id"
          loading={instrumentsLoading}
          size="small"
          pagination={{
            current: instrumentPage,
            pageSize: PAGE_SIZE,
            total: instrumentsTotal,
            showTotal: (total) => `共 ${total} 条`,
            showSizeChanger: false,
            onChange: (page) => setInstrumentPage(page),
          }}
          locale={{ emptyText: <Empty description="暂无证券数据" /> }}
          scroll={{ x: 900 }}
        />
      </Card>
    </div>
  );

  const renderSyncJobsTab = () => (
    <div>
      <Card size="small" style={{ marginBottom: 16 }}>
        <Space wrap>
          <Button
            icon={<SyncOutlined />}
            onClick={() => handleCreateSync('instruments')}
          >
            同步证券列表
          </Button>
          <Button
            icon={<SyncOutlined />}
            onClick={() => handleCreateSync('calendars')}
          >
            同步交易日历
          </Button>
          <Button
            icon={<SyncOutlined />}
            type="primary"
            onClick={() => handleCreateSync('history')}
          >
            历史回补
          </Button>
          <Button
            icon={<SyncOutlined />}
            onClick={() => handleCreateSync('incremental')}
          >
            增量更新
          </Button>
          <Button
            icon={<ReloadOutlined />}
            onClick={() => fetchSyncJobs(1)}
          >
            刷新
          </Button>
        </Space>
      </Card>

      <Card size="small">
        <Table<SyncJob>
          columns={syncJobColumns}
          dataSource={syncJobs}
          rowKey="id"
          loading={syncJobsLoading}
          size="small"
          pagination={{
            current: syncJobsPage,
            pageSize: PAGE_SIZE,
            total: syncJobsTotal,
            showTotal: (total) => `共 ${total} 条`,
            showSizeChanger: false,
            onChange: (page) => setSyncJobsPage(page),
          }}
          locale={{ emptyText: <Empty description="暂无同步任务" /> }}
          expandable={{
            expandedRowKeys: expandedJobIds,
            onExpand: handleExpandJob as never,
            expandedRowRender: (record) => {
              const items = jobItemsCache[record.id];
              if (!items) return <Spin size="small" />;
              if (items.length === 0) return <Empty description="无任务明细" />;
              return (
                <Table
                  columns={jobItemColumns}
                  dataSource={items}
                  rowKey="id"
                  size="small"
                  pagination={false}
                />
              );
            },
          }}
          scroll={{ x: 900 }}
        />
      </Card>
    </div>
  );

  const renderQualityTab = () => (
    <div>
      <Card size="small" style={{ marginBottom: 16 }}>
        <Space wrap>
          <Select
            value={qualitySeverity}
            onChange={setQualitySeverity}
            options={SEVERITY_OPTIONS}
            style={{ width: 120 }}
            placeholder="严重程度"
          />
          <Select
            value={qualityStatus}
            onChange={setQualityStatus}
            options={ISSUE_STATUS_OPTIONS}
            style={{ width: 120 }}
            placeholder="状态"
          />
          <Button
            type="primary"
            icon={<SearchOutlined />}
            onClick={() => {
              setQualityPage(1);
              fetchQualityIssues(1);
            }}
          >
            筛选
          </Button>
          <Button
            icon={<SyncOutlined />}
            onClick={() => setQualityModalOpen(true)}
          >
            重新检查
          </Button>
        </Space>
      </Card>

      <Card size="small">
        <Table<DataQualityIssue>
          columns={qualityIssueColumns}
          dataSource={qualityIssues}
          rowKey="id"
          loading={qualityLoading}
          size="small"
          pagination={{
            current: qualityPage,
            pageSize: PAGE_SIZE,
            total: qualityTotal,
            showTotal: (total) => `共 ${total} 条`,
            showSizeChanger: false,
            onChange: (page) => setQualityPage(page),
          }}
          locale={{ emptyText: <Empty description="暂无数据质量记录" /> }}
          scroll={{ x: 900 }}
        />
      </Card>
    </div>
  );

  return (
    <div style={{ padding: 16, height: '100%', overflow: 'auto' }}>
      <Title level={4} style={{ marginBottom: 16 }}>
        行情数据管理
      </Title>

      <Tabs
        activeKey={activeTab}
        onChange={(key) => setActiveTab(key)}
        items={[
          {
            key: 'instruments',
            label: '证券数据',
            children: renderInstrumentsTab(),
          },
          {
            key: 'syncJobs',
            label: '同步任务',
            children: renderSyncJobsTab(),
          },
          {
            key: 'quality',
            label: '数据质量',
            children: renderQualityTab(),
          },
        ]}
      />

      <CreateSyncModal
        open={createSyncModal.open}
        jobType={createSyncModal.jobType}
        onClose={() => setCreateSyncModal({ open: false, jobType: 'instruments' })}
        onSubmit={handleSyncSubmit}
      />

      <DataQualityModal
        open={qualityModalOpen}
        onClose={() => setQualityModalOpen(false)}
        onSubmit={handleRecheck}
      />
    </div>
  );
}
