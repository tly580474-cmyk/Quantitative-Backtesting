import { useEffect, useMemo, useRef, useState } from 'react';
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
  Skeleton,
  Space,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import {
  DeleteOutlined,
  ExportOutlined,
  FolderOpenOutlined,
  LineChartOutlined,
  SearchOutlined,
  StockOutlined,
  SyncOutlined,
} from '@ant-design/icons';
import { apiFetch } from '@/api/client';
import { DATA_SOURCE } from '@/api/config';
import { getRepository } from '@/api/useRepository';
import { exportDatabaseToExcel } from '@/db/databaseExport';
import type { MarketDataset } from '@/models';
import { useCandleStore } from '@/stores/useCandleStore';
import { getDatasetAssetType, type DatasetAssetType } from './datasetAssetType';
import { amountYuanToYi } from './historyBar';

const { Text, Title } = Typography;

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

interface HistoryBar {
  tradeDate: string;
  open: number;
  high: number;
  low: number;
  close: number;
  previousClose?: number;
  volume?: number;
  amount?: number;
  turnoverRatePct?: number;
}

export default function DataLibrary({ onOpen }: DataLibraryProps) {
  const { message } = App.useApp();
  const [datasets, setDatasets] = useState<MarketDataset[]>([]);
  const [activeType, setActiveType] = useState<DatasetAssetType>('index');
  const [search, setSearch] = useState('');
  const [stockQuery, setStockQuery] = useState('');
  const [stockItems, setStockItems] = useState<HistoryInstrument[]>([]);
  const [stockTotal, setStockTotal] = useState(0);
  const [stockPage, setStockPage] = useState(1);
  const [stockPageSize, setStockPageSize] = useState(20);
  const [excludeDelisted, setExcludeDelisted] = useState(true);
  const [excludeSt, setExcludeSt] = useState(true);
  const [stockLoading, setStockLoading] = useState(false);
  const [stockError, setStockError] = useState<string | null>(null);
  const [stockRefreshKey, setStockRefreshKey] = useState(0);
  const [openingInstrumentId, setOpeningInstrumentId] = useState<string | null>(null);
  const [updatingGroup, setUpdatingGroup] = useState<IndexDatasetUpdateResult['group'] | null>(null);
  const stockRequestRef = useRef(0);
  const setCandles = useCandleStore((state) => state.setCandles);
  const setImportResult = useCandleStore((state) => state.setImportResult);

  const refresh = async () => {
    setDatasets(await getRepository().getDatasets());
  };

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setStockQuery(search.trim());
      setStockPage(1);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [search]);

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
  ]);

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
      const result = await apiFetch<{ items: HistoryBar[]; total: number }>(
        `/api/instruments/${instrument.id}/candles?offset=0&limit=10000`,
        { timeoutMs: 60000 },
      );
      const candles = result.items.map((bar) => ({
        time: bar.tradeDate,
        symbol: instrument.symbol,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume,
        turnover: amountYuanToYi(bar.amount),
        turnoverRatePct: bar.turnoverRatePct,
      }));
      setCandles(candles);
      setImportResult({
        success: true,
        fileName: `MySQL历史库 · ${instrument.name}`,
        symbol: instrument.symbol,
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
          <List
            className="data-library-list"
            rowKey="id"
            dataSource={items}
            pagination={items.length > 20 ? {
              pageSize: 20,
              showSizeChanger: true,
              pageSizeOptions: [20, 50, 100],
              showTotal: (total) => `共 ${total} 个数据集`,
            } : false}
            renderItem={(dataset) => (
              <List.Item
                actions={[
                  <Button
                    key="open"
                    type="link"
                    icon={<FolderOpenOutlined />}
                    onClick={() => handleOpen(dataset)}
                  >
                    打开
                  </Button>,
                  <Popconfirm
                    key="delete"
                    title="确定删除此数据集？"
                    description="数据集及其全部 K 线将被永久删除。"
                    okText="删除"
                    cancelText="取消"
                    okButtonProps={{ danger: true }}
                    onConfirm={() => handleDelete(dataset.id)}
                  >
                    <Button type="link" danger icon={<DeleteOutlined />}>
                      删除
                    </Button>
                  </Popconfirm>,
                ]}
              >
                <List.Item.Meta
                  title={<Text strong>{dataset.name}</Text>}
                  description={
                    <Space size={[8, 4]} wrap>
                      <Tag color={assetType === 'index' ? 'geekblue' : 'cyan'}>{dataset.symbol}</Tag>
                      <Text type="secondary">{dataset.startTime} ~ {dataset.endTime}</Text>
                      <Tag>{dataset.count.toLocaleString()} 条</Tag>
                      {dataset.sourceFileName && (
                        <Text type="secondary">来源：{dataset.sourceFileName}</Text>
                      )}
                    </Space>
                  }
                />
              </List.Item>
            )}
          />
        )}
      </>
    );
  };

  const renderHistoryStockList = () => (
    <>
      <div className="data-library-section-head">
        <div>
          <Text strong>个股行情数据</Text>
          <Text type="secondary">MySQL 全量历史库 · 服务端分页读取</Text>
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
          description={stockQuery ? '没有匹配的证券' : '暂无个股行情数据'}
        />
      ) : (
        <>
          <List
            className="data-library-list data-library-stock-list"
            rowKey="id"
            loading={stockLoading}
            dataSource={stockItems}
            renderItem={(instrument) => (
              <List.Item
                actions={[
                  <Button
                    key="open"
                    type="link"
                    icon={<FolderOpenOutlined />}
                    loading={openingInstrumentId === instrument.id}
                    disabled={instrument.recordCount <= 0 || openingInstrumentId != null}
                    onClick={() => handleOpenInstrument(instrument)}
                  >
                    打开
                  </Button>,
                ]}
              >
                <List.Item.Meta
                  title={(
                    <Space size={8} wrap>
                      <Text strong>{instrument.name}</Text>
                      <Text code>{instrument.symbol}</Text>
                      <Tag>{instrument.market}</Tag>
                      {instrument.status !== 'active' && (
                        <Tag color={instrument.status === 'delisted' ? 'default' : 'gold'}>
                          {instrument.status === 'delisted' ? '已退市' : '停牌'}
                        </Tag>
                      )}
                      {instrument.qualityStatus === 'blocked' && <Tag color="red">质量阻断</Tag>}
                      {instrument.qualityStatus === 'warning' && <Tag color="gold">质量警告</Tag>}
                    </Space>
                  )}
                  description={(
                    <Space size={[10, 4]} wrap>
                      {instrument.industry && <Text type="secondary">{instrument.industry}</Text>}
                      {instrument.startDate && instrument.endDate ? (
                        <Text type="secondary">
                          {instrument.startDate} ~ {instrument.endDate}
                        </Text>
                      ) : (
                        <Text type="secondary">暂无行情范围</Text>
                      )}
                      <Tag>{instrument.recordCount.toLocaleString()} 条</Tag>
                    </Space>
                  )}
                />
              </List.Item>
            )}
          />
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
    <div className="data-library-page">
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

      <Tabs
        className="data-library-tabs"
        activeKey={activeType}
        onChange={(key) => setActiveType(key as DatasetAssetType)}
        items={[
          {
            key: 'index',
            label: (
              <Space size={6}>
                <LineChartOutlined />
                <span>指数行情</span>
                <Tag variant="filled">{totals.index}</Tag>
              </Space>
            ),
            children: renderDatasetList('index'),
          },
          {
            key: 'stock',
            label: (
              <Space size={6}>
                <StockOutlined />
                <span>个股行情</span>
                <Tag variant="filled">
                  {DATA_SOURCE === 'api' ? stockTotal : totals.stock}
                </Tag>
              </Space>
            ),
            children: DATA_SOURCE === 'api'
              ? renderHistoryStockList()
              : renderDatasetList('stock'),
          },
        ]}
      />
    </div>
  );
}
