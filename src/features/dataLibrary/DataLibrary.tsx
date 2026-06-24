import { useEffect, useState } from 'react';
import { List, Button, Popconfirm, Tag, Typography, Empty, Space, Input, App, Modal } from 'antd';
import { DeleteOutlined, FolderOpenOutlined, SearchOutlined, ExportOutlined, SyncOutlined } from '@ant-design/icons';
import { apiFetch } from '@/api/client';
import { DATA_SOURCE } from '@/api/config';
import { getRepository } from '@/api/useRepository';
import { useCandleStore } from '@/stores/useCandleStore';
import type { MarketDataset } from '@/models';
import { exportDatabaseToExcel } from '@/db/databaseExport';
import MigrationPanel from '@/components/MigrationPanel';

const { Text } = Typography;

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

export default function DataLibrary({ onOpen }: DataLibraryProps) {
  const { message } = App.useApp();
  const [datasets, setDatasets] = useState<MarketDataset[]>([]);
  const [search, setSearch] = useState('');
  const [updatingGroup, setUpdatingGroup] = useState<IndexDatasetUpdateResult['group'] | null>(null);
  const setCandles = useCandleStore((s) => s.setCandles);
  const setImportResult = useCandleStore((s) => s.setImportResult);

  const refresh = async () => {
    setDatasets(await getRepository().getDatasets());
  };

  useEffect(() => {
    refresh();
  }, []);

  const handleOpen = async (ds: MarketDataset) => {
    const candles = await getRepository().getCandlesByDataset(ds.id);
    setCandles(candles);
    setImportResult({
      success: true,
      fileName: ds.sourceFileName ?? ds.name,
      symbol: ds.symbol,
      dateRange: { from: ds.startTime, to: ds.endTime },
      totalRows: ds.count,
      validRows: ds.count,
      errors: [],
      warnings: [],
      candles,
    });
    onOpen?.();
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

  const filtered = search
    ? datasets.filter(
        (d) =>
          d.name.includes(search) ||
          d.symbol.includes(search),
      )
    : datasets;

  return (
    <div style={{ padding: 16, height: '100%', overflow: 'auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <Text strong style={{ fontSize: 16 }}>本地行情数据集</Text>
        <Space wrap>
          <Input
            prefix={<SearchOutlined />}
            placeholder="搜索名称或标的"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ width: 240 }}
            allowClear
          />
          <Button icon={<ExportOutlined />} onClick={handleExportDatabase}>
            导出数据库
          </Button>
          <Button
            icon={<SyncOutlined />}
            loading={updatingGroup === 'cn-index'}
            disabled={updatingGroup != null}
            onClick={() => handleIndexUpdate('cn-index')}
          >
            更新沪深中证指数
          </Button>
          <Button
            icon={<SyncOutlined />}
            loading={updatingGroup === 'us-index'}
            disabled={updatingGroup != null}
            onClick={() => handleIndexUpdate('us-index')}
          >
            更新纳斯达克100
          </Button>
        </Space>
      </div>
      {filtered.length === 0 ? (
        <Empty description="暂无保存的数据集" />
      ) : (
        <List
          dataSource={filtered}
          renderItem={(ds) => (
            <List.Item
              actions={[
                <Button
                  key="open"
                  type="link"
                  icon={<FolderOpenOutlined />}
                  onClick={() => handleOpen(ds)}
                >
                  打开
                </Button>,
                <Popconfirm
                  key="delete"
                  title="确定删除此数据集？"
                  onConfirm={() => handleDelete(ds.id)}
                >
                  <Button type="link" danger icon={<DeleteOutlined />}>
                    删除
                  </Button>
                </Popconfirm>,
              ]}
            >
              <List.Item.Meta
                title={ds.name}
                description={
                  <Space size="small">
                    <Tag color="blue">{ds.symbol}</Tag>
                    <Text type="secondary">
                      {ds.startTime} ~ {ds.endTime}
                    </Text>
                    <Tag>{ds.count} 条</Tag>
                    {ds.sourceFileName && (
                      <Text type="secondary">来源: {ds.sourceFileName}</Text>
                    )}
                  </Space>
                }
              />
            </List.Item>
          )}
        />
      )}
      <div style={{ marginTop: 16 }}>
        <MigrationPanel />
      </div>
    </div>
  );
}
