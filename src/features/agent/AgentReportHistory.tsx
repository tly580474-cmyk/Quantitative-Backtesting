import { useState, useEffect, useCallback } from 'react';
import { Table, Button, Card, Typography, Space, App, Tag, Empty, Tooltip } from 'antd';
import { DownloadOutlined, EyeOutlined, ReloadOutlined, FileTextOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import type { AgentReport } from './types';
import { listAgentReports, getReportDownloadUrl } from './api';
import { API_BASE_URL } from '@/api/config';

const { Title, Text } = Typography;

function formatFileSize(bytes: number | null): string {
  if (!bytes) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return iso;
  }
}

export default function AgentReportHistory() {
  const [reports, setReports] = useState<AgentReport[]>([]);
  const [loading, setLoading] = useState(false);
  const { message } = App.useApp();

  const fetchReports = useCallback(async () => {
    setLoading(true);
    try {
      const result = await listAgentReports(100);
      setReports(result.reports ?? []);
    } catch (err) {
      message.error(`加载失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    fetchReports();
  }, [fetchReports]);

  const handleDownload = (runId: string, title: string) => {
    const a = document.createElement('a');
    a.href = `${API_BASE_URL}${getReportDownloadUrl(runId)}`;
    a.download = `${title}.html`;
    a.click();
  };

  const handleView = (runId: string) => {
    window.open(`${API_BASE_URL}/api/agent/reports/${runId}/html`, '_blank');
  };

  const columns: ColumnsType<AgentReport> = [
    {
      title: '报告标题',
      dataIndex: 'title',
      key: 'title',
      ellipsis: true,
      render: (title: string) => (
        <Space>
          <FileTextOutlined style={{ color: '#1a73e8' }} />
          <Text strong>{title}</Text>
        </Space>
      ),
    },
    {
      title: '摘要',
      dataIndex: 'summary',
      key: 'summary',
      ellipsis: true,
      width: '30%',
      render: (summary: string | null) => (
        summary ? <Text type="secondary">{summary}</Text> : <Text type="secondary">-</Text>
      ),
    },
    {
      title: '大小',
      dataIndex: 'fileSize',
      key: 'fileSize',
      width: 100,
      render: (size: number | null) => <Text type="secondary">{formatFileSize(size)}</Text>,
    },
    {
      title: '图表数',
      dataIndex: 'chartsCount',
      key: 'chartsCount',
      width: 80,
      render: (count: number) => count > 0 ? <Tag color="blue">{count}</Tag> : <Text type="secondary">-</Text>,
    },
    {
      title: '生成时间',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 180,
      render: (date: string) => <Text type="secondary">{formatDate(date)}</Text>,
    },
    {
      title: '操作',
      key: 'actions',
      width: 140,
      render: (_, record) => (
        <Space size="small">
          <Tooltip title="新窗口查看">
            <Button aria-label="查看报告" size="small" icon={<EyeOutlined />} onClick={() => handleView(record.runId)} />
          </Tooltip>
          <Tooltip title="下载 HTML">
            <Button aria-label="下载 HTML 报告" size="small" icon={<DownloadOutlined />} onClick={() => handleDownload(record.runId, record.title)} />
          </Tooltip>
        </Space>
      ),
    },
  ];

  return (
    <div className="agent-history-page">
      <div className="agent-history-header">
        <Title level={4} style={{ margin: 0 }}>报告历史</Title>
        <Button icon={<ReloadOutlined />} onClick={fetchReports} loading={loading}>刷新</Button>
      </div>
      <Card styles={{ body: { padding: 0 } }}>
        <Table
          columns={columns}
          dataSource={reports}
          rowKey="runId"
          loading={loading}
          pagination={{ pageSize: 20, showSizeChanger: false }}
          scroll={{ x: 900 }}
          locale={{ emptyText: <Empty description="暂无报告" /> }}
          size="middle"
        />
      </Card>
    </div>
  );
}
