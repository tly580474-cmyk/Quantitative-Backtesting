import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Table, Button, Card, Typography, Space, App, Tag, Empty, Select, Tooltip, Modal, Popconfirm } from 'antd';
import { ReloadOutlined, EyeOutlined, StopOutlined, RedoOutlined, DeleteOutlined, MessageOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import type { AgentRun, AgentEvent } from './types';
import { listAgentRuns, cancelAgentRun, getAgentRun, deleteAgentRun } from './api';
import { AgentEventList } from './AgentEventList';

const { Title, Text } = Typography;

const STATUS_COLORS: Record<string, string> = {
  pending: 'default',
  running: 'processing',
  completed: 'success',
  failed: 'error',
  canceled: 'warning',
};

const STATUS_TEXTS: Record<string, string> = {
  pending: '等待中',
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  canceled: '已取消',
};

function formatDate(iso: string | null): string {
  if (!iso) return '-';
  try {
    return new Date(iso).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return iso;
  }
}

function formatDuration(start: string | null, end: string | null): string {
  if (!start || !end) return '-';
  try {
    const diff = new Date(end).getTime() - new Date(start).getTime();
    if (diff < 60000) return `${(diff / 1000).toFixed(1)}s`;
    return `${Math.floor(diff / 60000)}m${Math.floor((diff % 60000) / 1000)}s`;
  } catch {
    return '-';
  }
}

export default function AgentRunHistory() {
  const navigate = useNavigate();
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [loading, setLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string | undefined>(undefined);
  const [detailRunId, setDetailRunId] = useState<string | null>(null);
  const [detailEvents, setDetailEvents] = useState<AgentEvent[]>([]);
  const [detailPrompt, setDetailPrompt] = useState('');
  const [detailLoading, setDetailLoading] = useState(false);
  const { message } = App.useApp();

  const fetchRuns = useCallback(async () => {
    setLoading(true);
    try {
      const result = await listAgentRuns(100, 0, statusFilter);
      setRuns(result.runs ?? []);
    } catch (err) {
      message.error(`加载失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
    }
  }, [statusFilter, message]);

  useEffect(() => {
    fetchRuns();
  }, [fetchRuns]);

  const handleCancel = async (runId: string) => {
    try {
      await cancelAgentRun(runId);
      message.success('已取消运行');
      fetchRuns();
    } catch {
      message.error('取消失败');
    }
  };

  const handleDelete = async (runId: string) => {
    try {
      await deleteAgentRun(runId);
      message.success('已删除');
      fetchRuns();
    } catch (err) {
      message.error(`删除失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleContinue = async (record: AgentRun) => {
    navigate(`/agent?continue=${record.id}`);
  };

  const handleViewDetail = async (runId: string) => {
    setDetailRunId(runId);
    setDetailLoading(true);
    setDetailEvents([]);
    setDetailPrompt('');
    try {
      const result = await getAgentRun(runId);
      setDetailEvents(result.events ?? []);
      setDetailPrompt(result.run?.prompt ?? '');
    } catch (err) {
      message.error(`加载详情失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setDetailLoading(false);
    }
  };

  // 重新发起：携带原 prompt 跳转回 Agent 运行页面，预填到输入框
  const handleRerun = (record: AgentRun) => {
    navigate(`/agent?prompt=${encodeURIComponent(record.prompt)}`);
  };

  const columns: ColumnsType<AgentRun> = [
    {
      title: 'Prompt',
      dataIndex: 'prompt',
      key: 'prompt',
      ellipsis: true,
      render: (prompt: string) => <Text>{prompt.slice(0, 80)}{prompt.length > 80 ? '...' : ''}</Text>,
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 100,
      render: (status: string) => <Tag color={STATUS_COLORS[status] ?? 'default'}>{STATUS_TEXTS[status] ?? status}</Tag>,
    },
    {
      title: '最大轮次',
      dataIndex: 'maxTurns',
      key: 'maxTurns',
      width: 90,
      render: (v: number) => <Text type="secondary">{v === 0 ? '不限制' : v}</Text>,
    },
    {
      title: '耗时',
      key: 'duration',
      width: 100,
      render: (_, record) => (
        <Text type="secondary">
          {record.status === 'running' ? '运行中...' : formatDuration(record.startedAt, record.finishedAt)}
        </Text>
      ),
    },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 180,
      render: (date: string) => <Text type="secondary">{formatDate(date)}</Text>,
    },
    {
      title: '操作',
      key: 'actions',
      width: 220,
      render: (_, record) => (
        <Space size="small">
          <Tooltip title="查看详情">
            <Button size="small" icon={<EyeOutlined />} onClick={() => handleViewDetail(record.id)} />
          </Tooltip>
          {(record.status === 'completed' || record.status === 'failed' || record.status === 'canceled') && (
            <Tooltip title="继续对话">
              <Button size="small" type="primary" ghost icon={<MessageOutlined />} onClick={() => handleContinue(record)} />
            </Tooltip>
          )}
          <Tooltip title="使用此 Prompt 重新发起">
            <Button size="small" icon={<RedoOutlined />} onClick={() => handleRerun(record)} />
          </Tooltip>
          {record.status === 'running' && (
            <Tooltip title="取消运行">
              <Button size="small" danger icon={<StopOutlined />} onClick={() => handleCancel(record.id)} />
            </Tooltip>
          )}
          {record.status !== 'running' && (
            <Popconfirm title="确定删除此运行记录？" onConfirm={() => handleDelete(record.id)} okText="删除" cancelText="取消">
              <Tooltip title="删除">
                <Button size="small" danger icon={<DeleteOutlined />} />
              </Tooltip>
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  return (
    <div style={{ padding: 24, height: '100%', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Title level={4} style={{ margin: 0 }}>运行历史</Title>
        <Space>
          <Select
            placeholder="筛选状态"
            allowClear
            style={{ width: 120 }}
            value={statusFilter}
            onChange={(v) => setStatusFilter(v ?? undefined)}
            options={[
              { value: 'running', label: '运行中' },
              { value: 'completed', label: '已完成' },
              { value: 'failed', label: '失败' },
              { value: 'canceled', label: '已取消' },
            ]}
          />
          <Button icon={<ReloadOutlined />} onClick={fetchRuns} loading={loading}>刷新</Button>
        </Space>
      </div>
      <Card styles={{ body: { padding: 0 } }}>
        <Table
          columns={columns}
          dataSource={runs}
          rowKey="id"
          loading={loading}
          pagination={{ pageSize: 20, showSizeChanger: false }}
          locale={{ emptyText: <Empty description="暂无运行记录" /> }}
          size="middle"
        />
      </Card>

      <Modal
        title="运行详情"
        open={!!detailRunId}
        onCancel={() => setDetailRunId(null)}
        footer={null}
        width={800}
        styles={{ body: { maxHeight: '60vh', overflow: 'auto' } }}
      >
        {detailLoading ? (
          <div style={{ textAlign: 'center', padding: 40 }}>
            <Text type="secondary">加载中...</Text>
          </div>
        ) : detailEvents.length === 0 ? (
          <Empty description="无事件数据" />
        ) : (
          <AgentEventList events={detailEvents} userPrompt={detailPrompt} />
        )}
      </Modal>
    </div>
  );
}
