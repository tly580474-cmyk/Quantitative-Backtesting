import { useEffect, useState } from 'react';
import { List, Button, Popconfirm, Tag, Typography, Empty, Space, Input } from 'antd';
import { DeleteOutlined, FolderOpenOutlined, SearchOutlined } from '@ant-design/icons';
import { getDatasets, deleteDataset } from '@/db/marketDataRepository';
import { getCandlesByDataset } from '@/db/marketDataRepository';
import { useCandleStore } from '@/stores/useCandleStore';
import type { MarketDataset } from '@/models';

const { Text } = Typography;

interface DataLibraryProps {
  onOpen?: () => void;
}

export default function DataLibrary({ onOpen }: DataLibraryProps) {
  const [datasets, setDatasets] = useState<MarketDataset[]>([]);
  const [search, setSearch] = useState('');
  const setCandles = useCandleStore((s) => s.setCandles);
  const setImportResult = useCandleStore((s) => s.setImportResult);

  const refresh = async () => {
    setDatasets(await getDatasets());
  };

  useEffect(() => {
    refresh();
  }, []);

  const handleOpen = async (ds: MarketDataset) => {
    const candles = await getCandlesByDataset(ds.id);
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
    await deleteDataset(id);
    await refresh();
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
        <Input
          prefix={<SearchOutlined />}
          placeholder="搜索名称或标的"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ width: 240 }}
          allowClear
        />
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
    </div>
  );
}
