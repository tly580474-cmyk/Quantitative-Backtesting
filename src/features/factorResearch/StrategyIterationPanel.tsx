import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Descriptions, Drawer, Space, Table, Tag, Typography, message } from 'antd';
import {
  fetchFactorStrategies,
  fetchFactorStrategyPerformance,
  type FactorStrategyPerformance,
  type FactorStrategyVersion,
} from './api';

const statusColor: Record<FactorStrategyVersion['status'], string> = {
  draft: 'default',
  validated: 'blue',
  paper: 'gold',
  champion: 'green',
  rejected: 'red',
};

export default function StrategyIterationPanel() {
  const [items, setItems] = useState<FactorStrategyVersion[]>([]);
  const [loading, setLoading] = useState(false);
  const [detail, setDetail] = useState<FactorStrategyPerformance | null>(null);
  const initialLoadStarted = useRef(false);
  const champion = useMemo(() => items.find((item) => item.status === 'champion'), [items]);
  const challengers = useMemo(() => items.filter((item) =>
    item.status === 'validated' || item.status === 'paper'), [items]);

  const reload = async () => {
    setLoading(true);
    try {
      setItems((await fetchFactorStrategies()).items);
    } catch (error) {
      void message.error(error instanceof Error ? error.message : '策略版本加载失败');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    if (initialLoadStarted.current) return;
    initialLoadStarted.current = true;
    void reload();
  }, []);

  return (
    <>
      <Space orientation="vertical" size={12} style={{ width: '100%' }}>
        <Alert
          type="info"
          showIcon
          title={`冠军：${champion?.name ?? '尚未指定'}；观察中的挑战者：${challengers.length}`}
          description="固定20个交易日调仓，100万元模拟资金；晋级必须完成6个周期、通过双基准门禁并由人工批准。系统不提供自动实盘发布。"
        />
        <Table
          rowKey="id"
          size="small"
          loading={loading}
          pagination={{ pageSize: 6, size: 'small' }}
          dataSource={items}
          columns={[
            { title: '版本', dataIndex: 'name' },
            { title: '角色/状态', dataIndex: 'status', render: (status: FactorStrategyVersion['status']) =>
              <Tag color={statusColor[status]}>{status}</Tag> },
            { title: '因子', render: (_: unknown, row: FactorStrategyVersion) =>
              `${row.factorVersions.length} 个 / ${new Set(row.factorVersions.map((item) => item.family)).size} 类` },
            { title: '快照', dataIndex: 'snapshotId', ellipsis: true },
            { title: '更新', dataIndex: 'updatedAt', render: (value: string) =>
              new Date(value).toLocaleString() },
            { title: '操作', render: (_: unknown, row: FactorStrategyVersion) =>
              <Button size="small" onClick={() => {
                void fetchFactorStrategyPerformance(row.id).then(setDetail)
                  .catch((error: unknown) => void message.error(
                    error instanceof Error ? error.message : '表现加载失败'));
              }}>表现与约束</Button> },
          ]}
        />
      </Space>
      <Drawer size="large" open={Boolean(detail)} onClose={() => setDetail(null)}
        title={detail ? `${detail.strategy.name} · 审计详情` : ''}>
        {detail && (
          <Space orientation="vertical" size={16} style={{ width: '100%' }}>
            <Descriptions bordered size="small" column={2} items={[
              { key: 'status', label: '状态', children: detail.strategy.status },
              { key: 'cycles', label: '模拟调仓周期',
                children: detail.observations.length
                  ? Math.max(...detail.observations.map((item) => item.rebalanceCycle)) : 0 },
              { key: 'cost', label: '成本',
                children: `买 ${String(detail.strategy.costConfig.buyBps)}bp / 卖 ${String(detail.strategy.costConfig.sellBps)}bp` },
              { key: 'failure', label: '优化失败策略',
                children: String(detail.strategy.optimizerConfig.failurePolicy) },
            ]} />
            <Typography.Title level={5}>逐周期模拟表现</Typography.Title>
            <Table rowKey="rebalanceCycle" size="small" pagination={false}
              dataSource={detail.observations}
              columns={[
                { title: '周期', dataIndex: 'rebalanceCycle' },
                { title: '日期', dataIndex: 'observationDate' },
                { title: '换手', render: (_: unknown, row) =>
                  String(row.metrics.turnover ?? '—') },
                { title: '交易成本', render: (_: unknown, row) =>
                  String(row.metrics.cost ?? '—') },
                { title: '合格池超额', render: (_: unknown, row) =>
                  String(row.metrics.eligibleUniverseExcess ?? '—') },
                { title: '中证500超额', render: (_: unknown, row) =>
                  String(row.metrics.csi500Excess ?? '—') },
                { title: '违规', render: (_: unknown, row) =>
                  row.violations.length ? <Tag color="red">{row.violations.join(', ')}</Tag> : <Tag color="green">无</Tag> },
              ]} />
          </Space>
        )}
      </Drawer>
    </>
  );
}
