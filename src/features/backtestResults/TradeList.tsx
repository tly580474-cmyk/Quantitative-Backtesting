import { Table, Tag } from 'antd';
import type { Trade } from '@/models';
import type { ColumnsType } from 'antd/es/table';

interface Props {
  trades: Trade[];
}

const columns: ColumnsType<Trade> = [
  {
    title: '时间',
    dataIndex: 'time',
    key: 'time',
    width: 110,
  },
  {
    title: '方向',
    dataIndex: 'side',
    key: 'side',
    width: 60,
    render: (side: string, record: Trade) => (
      <Tag color={side === 'buy' ? 'green' : 'red'}>
        {record.forceClose ? '强平' : side === 'buy' ? '买入' : '卖出'}
      </Tag>
    ),
  },
  {
    title: '数量',
    dataIndex: 'quantity',
    key: 'quantity',
    width: 80,
    align: 'right',
  },
  {
    title: '成交价',
    dataIndex: 'fillPrice',
    key: 'fillPrice',
    width: 80,
    align: 'right',
    render: (v: number) => v.toFixed(2),
  },
  {
    title: '成交额',
    dataIndex: 'amount',
    key: 'amount',
    width: 100,
    align: 'right',
    render: (v: number) => `¥ ${v.toFixed(2)}`,
  },
  {
    title: '手续费',
    dataIndex: 'commission',
    key: 'commission',
    width: 80,
    align: 'right',
    render: (v: number) => v.toFixed(2),
  },
  {
    title: '印花税',
    dataIndex: 'tax',
    key: 'tax',
    width: 80,
    align: 'right',
    render: (v: number) => v.toFixed(2),
  },
  {
    title: '滑点成本',
    dataIndex: 'slippageCost',
    key: 'slippageCost',
    width: 80,
    align: 'right',
    render: (v: number) => v.toFixed(2),
  },
];

export default function TradeList({ trades }: Props) {
  const filledTrades = trades.filter((t) => t.quantity > 0);

  return (
    <Table
      columns={columns}
      dataSource={filledTrades}
      rowKey="id"
      size="small"
      pagination={{ pageSize: 20, showTotal: (total) => `共 ${total} 笔成交` }}
      scroll={{ x: 750 }}
      locale={{ emptyText: '暂无成交记录' }}
    />
  );
}
