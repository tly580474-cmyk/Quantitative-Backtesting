import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Checkbox,
  Empty,
  Input,
  List,
  Modal,
  Pagination,
  Popconfirm,
  Progress,
  Select,
  Skeleton,
  Space,
  Tag,
  Typography,
} from 'antd';
import {
  DeleteOutlined,
  DownloadOutlined,
  ExportOutlined,
  FolderOpenOutlined,
  LineChartOutlined,
  SearchOutlined,
  StockOutlined,
  SyncOutlined,
} from '@ant-design/icons';
import { apiFetch } from '@/api/client';
import { DATA_SOURCE, INDEXEDDB_MIGRATION_MODE } from '@/api/config';
import { getRepository } from '@/api/useRepository';
import { WorkbenchPanel } from '@/components/WorkbenchPanel';
import { exportDatabaseToExcel } from '@/db/databaseExport';
import type { MarketDataset } from '@/models';
import { useCandleStore } from '@/stores/useCandleStore';
import { useDataLibraryViewStore } from '@/stores/useDataLibraryViewStore';
import { getDatasetAssetType, type DatasetAssetType } from './datasetAssetType';
import { fetchHistoryCandles } from './historyBar';
import { fetchAdjustedDatasets, exportAdjustedKlinesToExcel } from '@/features/marketData/exportMarketData';
import type { SyncJob } from '../marketData/types';

const { Text, Title } = Typography;
const STOCK_SYNC_TIME = '15:30';
const STOCK_SYNC_POLL_MS = 3000;

interface DataLibraryProps {
  onOpen?: () => void;
}

interface IndexDatasetUpdateResult {
  group: 'cn-index' | 'us-index';
  targetDate: string;
  scanned: number;
  updated: number;
  skipped: number;
  failed: number;
  details: Array<{
    datasetId: string;
    symbol: string;
    status: 'updated' | 'skipped' | 'failed';
    fromDate?: string;
    toDate?: string;
    inserted?: number;
    reason?: string;
  }>;
}

interface HistoryInstrument {
  id: string;
  market: 'SH' | 'SZ' | 'BJ';
  symbol: string;
  name: string;
  industry?: string;
  status: 'active' | 'delisted' | 'suspended';
  listDate?: string;
  delistDate?: string;
  startDate?: string;
  endDate?: string;
  recordCount: number;
  qualityStatus?: 'pass' | 'warning' | 'blocked';
}

interface IndustryCount {
  industry: string;
  count: number;
}

export default function DataLibrary({ onOpen }: DataLibraryProps) {
  const { message } = App.useApp();
  const [datasets, setDatasets] = useState<MarketDataset[]>([]);
  const activeType = useDataLibraryViewStore((state) => state.activeType);
  const setActiveType = useDataLibraryViewStore((state) => state.setActiveType);
  const search = useDataLibraryViewStore((state) => state.search);
  const setSearch = useDataLibraryViewStore((state) => state.setSearch);
  const stockPage = useDataLibraryViewStore((state) => state.stockPage);
  const setStockPage = useDataLibraryViewStore((state) => state.setStockPage);
  const stockPageSize = useDataLibraryViewStore((state) => state.stockPageSize);
  const setStockPageSize = useDataLibraryViewStore((state) => state.setStockPageSize);
  const selectedIndustry = useDataLibraryViewStore((state) => state.selectedIndustry);
  const setSelectedIndustry = useDataLibraryViewStore((state) => state.setSelectedIndustry);
  const excludeDelisted = useDataLibraryViewStore((state) => state.excludeDelisted);
  const setExcludeDelisted = useDataLibraryViewStore((state) => state.setExcludeDelisted);
  const excludeSt = useDataLibraryViewStore((state) => state.excludeSt);
  const setExcludeSt = useDataLibraryViewStore((state) => state.setExcludeSt);
  const [stockQuery, setStockQuery] = useState(() => search.trim());
  const [stockItems, setStockItems] = useState<HistoryInstrument[]>([]);
  const [stockTotal, setStockTotal] = useState(0);
  const [industryItems, setIndustryItems] = useState<IndustryCount[]>([]);
  const [industryTotal, setIndustryTotal] = useState(0);
  const [industryLoading, setIndustryLoading] = useState(false);
  const [stockLoading, setStockLoading] = useState(false);
  const [stockError, setStockError] = useState<string | null>(null);
  const [stockRefreshKey, setStockRefreshKey] = useState(0);
  const [openingInstrumentId, setOpeningInstrumentId] = useState<string | null>(null);
  const [exportingInstrumentId, setExportingInstrumentId] = useState<string | null>(null);
  const [updatingGroup, setUpdatingGroup] = useState<IndexDatasetUpdateResult['group'] | null>(null);
  const [stockSyncJob, setStockSyncJob] = useState<SyncJob | null>(null);
  const [stockSyncLoading, setStockSyncLoading] = useState(false);
  const [startingStockSync, setStartingStockSync] = useState(false);
  const stockRequestRef = useRef(0);
  const industryRequestRef = useRef(0);
  const stockSyncRequestRef = useRef(0);
  const lastObservedStockSyncIdRef = useRef<string | null>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const savedScrollTopRef = useRef(useDataLibraryViewStore.getState().scrollTop);
  const setCandles = useCandleStore((state) => state.setCandles);
  const setImportResult = useCandleStore((state) => state.setImportResult);

  const refresh = async () => {
    setDatasets(await getRepository().getDatasets());
  };

  useEffect(() => {
    void refresh();
  }, []);

  const loadLatestStockSyncJob = useCallback(async (silent = false) => {
    if (DATA_SOURCE !== 'api') return;
    const requestId = ++stockSyncRequestRef.current;
    if (!silent) setStockSyncLoading(true);
    try {
      const result = await apiFetch<{ items: SyncJob[]; total: number }>(
        '/api/sync/jobs?jobType=incremental&limit=1',
      );
      if (stockSyncRequestRef.current !== requestId) return;
      const nextJob = result.items[0] ?? null;
      setStockSyncJob((previous) => {
        const wasRunning = previous?.status === 'pending' || previous?.status === 'running';
        const isTerminal = nextJob?.status === 'completed' || nextJob?.status === 'failed' || nextJob?.status === 'cancelled';
        const justFinished = nextJob && previous?.id === nextJob.id && wasRunning && isTerminal;
        if (justFinished) {
          setStockRefreshKey((value) => value + 1);
          if (nextJob.status === 'completed') {
            message.success('个股行情更新完成，已刷新列表');
          } else if (nextJob.status === 'failed') {
            message.warning('个股行情更新结束，但存在失败项');
          }
        }
        if (nextJob?.id && lastObservedStockSyncIdRef.current == null) {
          lastObservedStockSyncIdRef.current = nextJob.id;
        }
        return nextJob;
      });
    } catch (error) {
      if (!silent) {
        message.error(error instanceof Error ? error.message : '同步进度加载失败');
      }
    } finally {
      if (stockSyncRequestRef.current === requestId) setStockSyncLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void loadLatestStockSyncJob(true);
  }, [loadLatestStockSyncJob]);

  useEffect(() => {
    if (DATA_SOURCE !== 'api') return;
    const isRunning = stockSyncJob?.status === 'pending' || stockSyncJob?.status === 'running';
    if (!isRunning) return;
    const timer = window.setInterval(() => {
      void loadLatestStockSyncJob(true);
    }, STOCK_SYNC_POLL_MS);
    return () => window.clearInterval(timer);
  }, [loadLatestStockSyncJob, stockSyncJob?.status]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const nextQuery = search.trim();
      setStockQuery((currentQuery) => {
        if (currentQuery !== nextQuery) setStockPage(1);
        return nextQuery;
      });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [search, setStockPage]);

  useEffect(() => {
    const page = pageRef.current;
    if (!page) return;
    const handleScroll = () => {
      useDataLibraryViewStore.getState().setScrollTop(page.scrollTop);
    };
    page.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      page.removeEventListener('scroll', handleScroll);
    };
  }, []);

  useEffect(() => {
    if (activeType === 'stock' && DATA_SOURCE === 'api' && stockLoading) return;
    if (activeType === 'stock' && DATA_SOURCE === 'api' && stockItems.length === 0) return;
    if (activeType === 'index' && datasets.length === 0) return;

    const page = pageRef.current;
    if (!page) return;
    let secondFrame: number | undefined;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        page.scrollTop = savedScrollTopRef.current;
      });
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      if (secondFrame !== undefined) window.cancelAnimationFrame(secondFrame);
    };
  }, [activeType, datasets.length, stockItems.length, stockLoading]);

  useEffect(() => {
    if (DATA_SOURCE !== 'api') return;
    const requestId = ++stockRequestRef.current;
    const params = new URLSearchParams({
      type: 'stock',
      offset: String((stockPage - 1) * stockPageSize),
      limit: String(stockPageSize),
      excludeDelisted: String(excludeDelisted),
      excludeSt: String(excludeSt),
    });
    if (stockQuery) params.set('search', stockQuery);
    if (selectedIndustry !== 'all') params.set('industry', selectedIndustry);

    setStockLoading(true);
    setStockError(null);
    void apiFetch<{ items: HistoryInstrument[]; total: number }>(
      `/api/instruments?${params.toString()}`,
    ).then((result) => {
      if (stockRequestRef.current !== requestId) return;
      setStockItems(result.items);
      setStockTotal(result.total);
    }).catch((error) => {
      if (stockRequestRef.current !== requestId) return;
      setStockError(error instanceof Error ? error.message : '个股数据库加载失败');
    }).finally(() => {
      if (stockRequestRef.current === requestId) setStockLoading(false);
    });
  }, [
    excludeDelisted,
    excludeSt,
    stockPage,
    stockPageSize,
    stockQuery,
    stockRefreshKey,
    selectedIndustry,
  ]);

  useEffect(() => {
    if (DATA_SOURCE !== 'api') return;
    const requestId = ++industryRequestRef.current;
    const params = new URLSearchParams({
      type: 'stock',
      excludeDelisted: String(excludeDelisted),
      excludeSt: String(excludeSt),
    });
    if (stockQuery) params.set('search', stockQuery);
    setIndustryLoading(true);
    void apiFetch<{ items: IndustryCount[]; total: number }>(
      `/api/instruments/industries?${params.toString()}`,
    ).then((result) => {
      if (industryRequestRef.current !== requestId) return;
      setIndustryItems(result.items);
      setIndustryTotal(result.total);
    }).catch(() => {
      if (industryRequestRef.current !== requestId) return;
      setIndustryItems([]);
      setIndustryTotal(0);
    }).finally(() => {
      if (industryRequestRef.current === requestId) setIndustryLoading(false);
    });
  }, [excludeDelisted, excludeSt, stockQuery, stockRefreshKey]);

  const groupedDatasets = useMemo(() => {
    const query = search.trim().toLowerCase();
    const result: Record<DatasetAssetType, MarketDataset[]> = { index: [], stock: [] };

    for (const dataset of datasets) {
      if (
        query &&
        !dataset.name.toLowerCase().includes(query) &&
        !dataset.symbol.toLowerCase().includes(query)
      ) {
        continue;
      }
      result[getDatasetAssetType(dataset)].push(dataset);
    }

    return result;
  }, [datasets, search]);

  const totals = useMemo(() => {
    const result: Record<DatasetAssetType, number> = { index: 0, stock: 0 };
    datasets.forEach((dataset) => {
      result[getDatasetAssetType(dataset)] += 1;
    });
    return result;
  }, [datasets]);

  const handleOpen = async (dataset: MarketDataset) => {
    const candles = await getRepository().getCandlesByDataset(dataset.id);
    setCandles(candles);
    setImportResult({
      success: true,
      fileName: dataset.sourceFileName ?? dataset.name,
      symbol: dataset.symbol,
      dateRange: { from: dataset.startTime, to: dataset.endTime },
      totalRows: dataset.count,
      validRows: dataset.count,
      errors: [],
      warnings: [],
      candles,
    });
    onOpen?.();
  };

  const handleOpenInstrument = async (instrument: HistoryInstrument) => {
    if (instrument.recordCount <= 0) {
      message.warning('该证券暂无可用日线数据');
      return;
    }
    setOpeningInstrumentId(instrument.id);
    try {
      const { response: result, candles } = await fetchHistoryCandles(
        instrument.id,
        instrument.symbol,
        'none',
      );
      setCandles(candles);
      setImportResult({
        success: true,
        fileName: `MySQL历史库 · ${instrument.name}`,
        symbol: instrument.symbol,
        name: instrument.name,
        dateRange: {
          from: instrument.startDate ?? candles[0]?.time ?? '',
          to: instrument.endDate ?? candles[candles.length - 1]?.time ?? '',
        },
        totalRows: result.total,
        validRows: candles.length,
        errors: [],
        warnings: instrument.qualityStatus === 'blocked'
          ? [{ row: 0, message: '该证券存在阻断级数据质量问题，请核查后再用于回测。' }]
          : [],
        candles,
        instrumentId: instrument.id,
        adjustmentMode: result.adjustmentMode,
        factorVersion: result.factorVersion,
        adjustmentQualityStatus: result.adjustmentQualityStatus,
        adjustmentWarnings: result.adjustmentWarnings,
      });
      if (instrument.qualityStatus === 'blocked') {
        message.warning('行情已打开，但该证券存在阻断级数据质量问题');
      }
      onOpen?.();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '历史行情读取失败');
    } finally {
      setOpeningInstrumentId(null);
    }
  };

  const handleExportInstrument = async (instrument: HistoryInstrument) => {
    if (instrument.recordCount <= 0) {
      message.warning('该证券暂无可用日线数据');
      return;
    }
    setExportingInstrumentId(instrument.id);
    try {
      const datasets = await fetchAdjustedDatasets(instrument.id, instrument.symbol);
      if (!datasets.raw?.length && !datasets.qfq?.length && !datasets.hfq?.length) {
        throw new Error('未获取到任何复权行情数据');
      }
      const fileName = exportAdjustedKlinesToExcel(
        { code: instrument.symbol, name: instrument.name },
        datasets,
      );
      message.success(`已导出 ${fileName}`);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '复权行情导出失败');
    } finally {
      setExportingInstrumentId(null);
    }
  };

  const handleDelete = async (id: string) => {
    await getRepository().deleteDataset(id);
    await refresh();
  };

  const handleExportDatabase = async () => {
    try {
      const fileName = await exportDatabaseToExcel();
      message.success(`已导出 ${fileName}`);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '数据库导出失败');
    }
  };

  const handleIndexUpdate = async (group: IndexDatasetUpdateResult['group']) => {
    if (DATA_SOURCE !== 'api') {
      message.info('当前使用浏览器本地 IndexedDB，手动指数更新需要切换到 MySQL/API 数据源。');
      return;
    }
    setUpdatingGroup(group);
    try {
      const result = await apiFetch<IndexDatasetUpdateResult>('/api/market-data/index-datasets/update', {
        method: 'POST',
        body: JSON.stringify({ group, force: true }),
        timeoutMs: 120000,
      });
      await refresh();
      const title = group === 'cn-index' ? '沪深中证指数更新完成' : '纳斯达克100更新完成';
      const failed = result.details.filter((item) => item.status === 'failed');
      if (result.failed > 0) message.warning(`${title}，但有 ${result.failed} 个失败`);
      else message.success(title);
      Modal.info({
        title,
        width: 720,
        content: (
          <div>
            <p>
              目标日期：{result.targetDate}；扫描 {result.scanned} 个，更新 {result.updated} 个，
              跳过 {result.skipped} 个，失败 {result.failed} 个。
            </p>
            <p>
              <Text type="secondary">
                日线数据仅同步至最近一个已收盘交易日；盘中手动更新不会写入当日未完成 K 线。
              </Text>
            </p>
            {result.details.length > 0 && (
              <List
                size="small"
                dataSource={result.details}
                renderItem={(item) => (
                  <List.Item>
                    <Space wrap>
                      <Tag color={item.status === 'updated' ? 'green' : item.status === 'failed' ? 'red' : 'default'}>
                        {item.status === 'updated' ? '已更新' : item.status === 'failed' ? '失败' : '跳过'}
                      </Tag>
                      <Text code>{item.symbol}</Text>
                      {item.inserted != null && <Text>新增 {item.inserted} 条</Text>}
                      {item.fromDate && <Text type="secondary">{item.fromDate} ~ {item.toDate}</Text>}
                      {item.reason && <Text type={item.status === 'failed' ? 'danger' : 'secondary'}>{item.reason}</Text>}
                    </Space>
                  </List.Item>
                )}
              />
            )}
            {failed.length > 0 && <Text type="secondary">失败项可稍后再次点击按钮重试。</Text>}
          </div>
        ),
      });
    } catch (error) {
      message.error(error instanceof Error ? error.message : '指数数据更新失败');
    } finally {
      setUpdatingGroup(null);
    }
  };

  const handleStockIncrementalUpdate = async () => {
    if (DATA_SOURCE !== 'api') {
      message.info('当前使用浏览器本地 IndexedDB，个股增量更新需要切换到 MySQL/API 数据源。');
      return;
    }
    setStartingStockSync(true);
    try {
      const result = await apiFetch<{ jobId: string }>('/api/sync/incremental', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      message.success('已提交个股行情更新任务');
      lastObservedStockSyncIdRef.current = result.jobId;
      const now = new Date().toISOString();
      setStockSyncJob({
        id: result.jobId,
        jobType: 'incremental',
        status: 'pending',
        providerId: '',
        requestSnapshot: { trigger: 'manual' },
        totalItems: 0,
        completedItems: 0,
        failedItems: 0,
        createdAt: now,
      });
      void loadLatestStockSyncJob(true);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '个股行情更新提交失败');
    } finally {
      setStartingStockSync(false);
    }
  };

  const renderStockSyncProgress = () => {
    const job = stockSyncJob;
    const processed = job ? job.completedItems + job.failedItems : 0;
    const percent = job && job.totalItems > 0
      ? Math.min(100, Math.round((processed / job.totalItems) * 100))
      : 0;
    const running = job?.status === 'pending' || job?.status === 'running';
    const statusText = job
      ? job.status === 'completed'
        ? '已完成'
        : job.status === 'failed'
          ? '有失败项'
          : job.status === 'cancelled'
            ? '已取消'
            : job.totalItems > 0
              ? '更新中'
              : '准备中'
      : '暂无任务';
    const progressStatus = job?.status === 'failed'
      ? 'exception'
      : job?.status === 'completed'
        ? 'success'
        : 'active';

    return (
      <div className="data-library-stock-sync" aria-live="polite">
        <div className="data-library-stock-sync-main">
          <div className="data-library-stock-sync-head">
            <Space size={8} wrap>
              <Text strong>盘后更新</Text>
              <Tag color="blue">每日 {STOCK_SYNC_TIME}</Tag>
              <Tag color={job?.status === 'failed' ? 'red' : running ? 'processing' : 'default'}>
                {statusText}
              </Tag>
            </Space>
          </div>
          <Progress
            percent={percent}
            status={progressStatus}
            size="small"
            showInfo={false}
          />
          <div className="data-library-stock-sync-meta">
            <Text type="secondary">
              {job && job.totalItems > 0
                ? `${processed.toLocaleString()} / ${job.totalItems.toLocaleString()}，成功 ${job.completedItems.toLocaleString()}，失败 ${job.failedItems.toLocaleString()}`
                : stockSyncLoading ? '正在读取同步进度' : '等待盘后更新任务'}
            </Text>
            {job?.createdAt && (
              <Text type="secondary">
                最近任务：{new Date(job.createdAt).toLocaleString('zh-CN')}
              </Text>
            )}
          </div>
        </div>
        <div className="data-library-stock-sync-actions">
          <Button
            icon={<DownloadOutlined />}
            loading={startingStockSync}
            disabled={running || startingStockSync}
            onClick={handleStockIncrementalUpdate}
          >
            更新个股行情
          </Button>
          <Button
            size="small"
            icon={<SyncOutlined />}
            loading={stockSyncLoading}
            onClick={() => loadLatestStockSyncJob(false)}
          >
            刷新进度
          </Button>
        </div>
      </div>
    );
  };

  const renderDatasetList = (assetType: DatasetAssetType) => {
    const items = groupedDatasets[assetType];
    return (
      <>
        <div className="data-library-section-head">
          <div>
            <Text strong>{assetType === 'index' ? '指数行情数据' : '个股行情数据'}</Text>
            <Text type="secondary">
              {assetType === 'index'
                ? '用于市场基准、指数对比与指数策略回测'
                : '用于个股研究、选股与个股策略回测'}
            </Text>
          </div>
          {assetType === 'index' && (
            <Space wrap>
              <Button
                icon={<SyncOutlined />}
                loading={updatingGroup === 'cn-index'}
                disabled={updatingGroup != null}
                title="盘后更新当日数据；盘中仅更新至前一交易日"
                onClick={() => handleIndexUpdate('cn-index')}
              >
                更新沪深中证指数
              </Button>
              <Button
                icon={<SyncOutlined />}
                loading={updatingGroup === 'us-index'}
                disabled={updatingGroup != null}
                title="纽约市场收盘后更新当日数据；盘中仅更新至前一交易日"
                onClick={() => handleIndexUpdate('us-index')}
              >
                更新纳斯达克100
              </Button>
            </Space>
          )}
        </div>

        {items.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={search ? '没有匹配的数据集' : `暂无${assetType === 'index' ? '指数' : '个股'}行情数据`}
          />
        ) : (
          <div className="data-library-list" role="list" aria-label={`${assetType === 'index' ? '指数' : '个股'}行情数据集`}>
            {items.map((dataset) => (
              <div key={dataset.id} className="data-library-row" role="listitem">
                <div className="data-library-row-main">
                  <div className="data-library-row-title">
                    <Text strong ellipsis>{dataset.name}</Text>
                    <Tag color={assetType === 'index' ? 'geekblue' : 'cyan'}>{dataset.symbol}</Tag>
                  </div>
                  <div className="data-library-row-meta">
                    <Text type="secondary">{dataset.startTime} ~ {dataset.endTime}</Text>
                    <Tag>{dataset.count.toLocaleString()} 条</Tag>
                    {dataset.sourceFileName && (
                      <Text type="secondary">来源：{dataset.sourceFileName}</Text>
                    )}
                  </div>
                </div>
                <div className="data-library-row-actions">
                  <Button
                    type="text"
                    icon={<FolderOpenOutlined />}
                    onClick={() => handleOpen(dataset)}
                  >
                    打开
                  </Button>
                  {!INDEXEDDB_MIGRATION_MODE && (
                    <Popconfirm
                      title="确定删除此数据集？"
                      description="数据集及其全部 K 线将被永久删除。"
                      okText="删除"
                      cancelText="取消"
                      okButtonProps={{ danger: true }}
                      onConfirm={() => handleDelete(dataset.id)}
                    >
                      <Button type="text" danger icon={<DeleteOutlined />}>
                        删除
                      </Button>
                    </Popconfirm>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </>
    );
  };

  const renderHistoryStockList = () => (
    <>
      <div className="data-library-section-head">
        <div>
          <Text strong>个股行情数据</Text>
          <Text type="secondary">MySQL 全量历史库 · 服务端分页读取 · 统一下午 {STOCK_SYNC_TIME} 更新</Text>
        </div>
        <div className="data-library-stock-controls">
          <div className="data-library-stock-filters" aria-label="个股列表筛选">
            <Checkbox
              checked={excludeDelisted}
              onChange={(event) => {
                setExcludeDelisted(event.target.checked);
                setStockPage(1);
              }}
            >
              不查看已退市股票
            </Checkbox>
            <Checkbox
              checked={excludeSt}
              onChange={(event) => {
                setExcludeSt(event.target.checked);
                setStockPage(1);
              }}
            >
              不查看 ST/*ST 股票
            </Checkbox>
          </div>
          <Space size={6} wrap>
            <Tag color="blue">不复权</Tag>
            <Text type="secondary">共 {stockTotal.toLocaleString()} 只证券</Text>
          </Space>
        </div>
      </div>

      {renderStockSyncProgress()}

      <div className="data-library-industry-bar">
        <div>
          <Text strong>行业分类</Text>
          <Text type="secondary">按所属行业筛选证券</Text>
        </div>
        <Select
          aria-label="选择证券行业"
          className="data-library-industry-select"
          value={selectedIndustry}
          loading={industryLoading}
          showSearch
          optionFilterProp="label"
          popupMatchSelectWidth={320}
          options={[
            {
              value: 'all',
              label: `全部行业（${industryTotal.toLocaleString()}）`,
            },
            ...industryItems.map((item) => ({
              value: item.industry,
              label: `${item.industry}（${item.count.toLocaleString()}）`,
            })),
          ]}
          onChange={(value) => {
            setSelectedIndustry(value);
            setStockPage(1);
          }}
        />
        {selectedIndustry !== 'all' && (
          <Tag
            closable
            color="blue"
            onClose={(event) => {
              event.preventDefault();
              setSelectedIndustry('all');
              setStockPage(1);
            }}
          >
            {selectedIndustry}
          </Tag>
        )}
      </div>

      {stockError && (
        <Alert
          className="data-library-stock-alert"
          type="error"
          showIcon
          message="个股数据库加载失败"
          description={stockError}
          action={(
            <Button size="small" onClick={() => setStockRefreshKey((value) => value + 1)}>
              重试
            </Button>
          )}
        />
      )}

      {stockLoading && stockItems.length === 0 ? (
        <div className="data-library-stock-loading" aria-live="polite">
          <Skeleton active paragraph={{ rows: 6 }} />
        </div>
      ) : stockItems.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            stockQuery || selectedIndustry !== 'all'
              ? '没有匹配的证券'
              : '暂无个股行情数据'
          }
        />
      ) : (
        <>
          <div className={stockLoading ? 'data-library-list data-library-stock-list is-loading' : 'data-library-list data-library-stock-list'} role="list" aria-label="个股行情证券列表">
            {stockItems.map((instrument) => (
              <div key={instrument.id} className="data-library-row" role="listitem">
                <div className="data-library-row-main">
                  <div className="data-library-row-title">
                    <Text strong ellipsis>{instrument.name}</Text>
                    <Text code>{instrument.symbol}</Text>
                    <Tag>{instrument.market}</Tag>
                    {instrument.status !== 'active' && (
                      <Tag color={instrument.status === 'delisted' ? 'default' : 'gold'}>
                        {instrument.status === 'delisted' ? '已退市' : '停牌'}
                      </Tag>
                    )}
                    {instrument.qualityStatus === 'blocked' && <Tag color="red">质量阻断</Tag>}
                  </div>
                  <div className="data-library-row-meta">
                    {instrument.industry && <Tag color="geekblue">{instrument.industry}</Tag>}
                    {instrument.startDate && instrument.endDate ? (
                      <Text type="secondary">
                        {instrument.startDate} ~ {instrument.endDate}
                      </Text>
                    ) : (
                      <Text type="secondary">暂无行情范围</Text>
                    )}
                    <Tag>{instrument.recordCount.toLocaleString()} 条</Tag>
                  </div>
                </div>
                <div className="data-library-row-actions">
                  <Button
                    type="text"
                    icon={<FolderOpenOutlined />}
                    loading={openingInstrumentId === instrument.id}
                    disabled={instrument.recordCount <= 0 || openingInstrumentId != null}
                    onClick={() => handleOpenInstrument(instrument)}
                  >
                    打开
                  </Button>
                  <Button
                    type="text"
                    icon={<DownloadOutlined />}
                    loading={exportingInstrumentId === instrument.id}
                    disabled={instrument.recordCount <= 0 || exportingInstrumentId != null}
                    onClick={() => handleExportInstrument(instrument)}
                  >
                    导出
                  </Button>
                </div>
              </div>
            ))}
          </div>
          <Pagination
            className="data-library-stock-pagination"
            current={stockPage}
            pageSize={stockPageSize}
            total={stockTotal}
            showSizeChanger
            pageSizeOptions={[20, 50, 100]}
            showTotal={(total) => `共 ${total.toLocaleString()} 只证券`}
            onChange={(page, pageSize) => {
              setStockPageSize(pageSize);
              setStockPage(pageSize !== stockPageSize ? 1 : page);
            }}
          />
        </>
      )}
    </>
  );

  return (
    <div ref={pageRef} className="data-library-page">
      <header className="data-library-header">
        <div>
          <Title level={4}>行情数据库</Title>
          <Text type="secondary">分类管理本地指数与个股日线数据</Text>
        </div>
        <div className="data-library-actions">
          <Input
            aria-label="搜索行情数据集"
            prefix={<SearchOutlined />}
            placeholder="搜索名称或代码"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            allowClear
          />
          <Button icon={<ExportOutlined />} onClick={handleExportDatabase}>
            导出数据库
          </Button>
        </div>
      </header>

      {INDEXEDDB_MIGRATION_MODE && (
        <Alert
          type="warning"
          showIcon
          message="IndexedDB 只读迁移模式"
          description="当前仅允许查看和导出历史浏览器数据，所有新增、修改和删除操作均已禁用。导出后请恢复 MySQL/API 模式。"
        />
      )}

      <div className="data-library-workbench">
        <aside className="data-library-sidebar">
          <WorkbenchPanel title="数据域" subtitle="行情类型与资产规模">
            <div className="data-library-domain-list" role="tablist" aria-label="行情数据域">
              <button
                type="button"
                role="tab"
                aria-selected={activeType === 'index'}
                className={activeType === 'index' ? 'data-library-domain is-active' : 'data-library-domain'}
                onClick={() => setActiveType('index')}
              >
                <span><LineChartOutlined /> 指数行情</span>
                <strong>{totals.index.toLocaleString()}</strong>
                <small>基准、指数策略与市场对比</small>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeType === 'stock'}
                className={activeType === 'stock' ? 'data-library-domain is-active' : 'data-library-domain'}
                onClick={() => setActiveType('stock')}
              >
                <span><StockOutlined /> 个股行情</span>
                <strong>{(DATA_SOURCE === 'api' ? stockTotal : totals.stock).toLocaleString()}</strong>
                <small>个股研究、选股与策略回测</small>
              </button>
            </div>
            <div className="data-library-kpi-grid">
              <div>
                <span>本地指数</span>
                <strong>{totals.index.toLocaleString()}</strong>
              </div>
              <div>
                <span>{DATA_SOURCE === 'api' ? '服务端个股' : '本地个股'}</span>
                <strong>{(DATA_SOURCE === 'api' ? stockTotal : totals.stock).toLocaleString()}</strong>
              </div>
            </div>
          </WorkbenchPanel>
        </aside>
        <main className="data-library-content-panel">
          <section className="data-library-surface">
            {activeType === 'index'
              ? renderDatasetList('index')
              : DATA_SOURCE === 'api'
                ? renderHistoryStockList()
                : renderDatasetList('stock')}
          </section>
        </main>
      </div>
    </div>
  );
}
