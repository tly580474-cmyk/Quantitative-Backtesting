import { useState } from 'react';
import { Button, Empty, Spin, Typography } from 'antd';
import { DownloadOutlined, ExpandAltOutlined } from '@ant-design/icons';
import { API_BASE_URL } from '@/api/config';
import { getReportDownloadUrl } from './api';

const { Text } = Typography;

interface Props {
  reportUrl: string | null;
  reportMeta: { title: string; summary: string } | null;
  runId: string | null;
}

export function AgentReportView({ reportUrl, reportMeta, runId }: Props) {
  const [loading, setLoading] = useState(true);

  if (!reportUrl || !runId) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
        <Empty description="等待报告生成..." />
      </div>
    );
  }

  const downloadUrl = `${API_BASE_URL}${getReportDownloadUrl(runId)}`;

  const handleDownload = () => {
    const a = document.createElement('a');
    a.href = downloadUrl;
    a.download = `${reportMeta?.title ?? 'report'}.html`;
    a.click();
  };

  const handleOpenInNewTab = () => {
    window.open(reportUrl, '_blank');
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div
        style={{
          padding: '8px 12px',
          display: 'flex',
          gap: 8,
          alignItems: 'center',
          borderBottom: '1px solid #f0f0f0',
        }}
      >
        <span style={{ fontWeight: 600, flex: 1, fontSize: 14 }}>
          {reportMeta?.title ?? '研究报告中...'}
        </span>
        {reportMeta?.summary && (
          <Text
            type="secondary"
            style={{
              fontSize: 12,
              flex: 2,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {reportMeta.summary}
          </Text>
        )}
        <Button size="small" icon={<DownloadOutlined />} onClick={handleDownload}>
          下载
        </Button>
        <Button size="small" icon={<ExpandAltOutlined />} onClick={handleOpenInNewTab}>
          新窗口
        </Button>
      </div>
      <div style={{ flex: 1, position: 'relative' }}>
        {loading && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Spin tip="加载报告中..." />
          </div>
        )}
        <iframe
          src={reportUrl}
          style={{ width: '100%', height: '100%', border: 'none' }}
          sandbox="allow-scripts allow-same-origin"
          title="Agent Report"
          onLoad={() => setLoading(false)}
        />
      </div>
    </div>
  );
}
