import { Button, Empty } from 'antd';
import { DownloadOutlined, ExpandAltOutlined } from '@ant-design/icons';
import { API_BASE_URL } from '@/api/config';
import { getReportDownloadUrl } from './api';

interface Props {
  reportUrl: string | null;
  reportMeta: { title: string; summary: string } | null;
  runId: string | null;
}

export function AgentReportView({ reportUrl, reportMeta, runId }: Props) {
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
      <div style={{ padding: '8px 12px', display: 'flex', gap: 8, alignItems: 'center', borderBottom: '1px solid #f0f0f0' }}>
        <span style={{ fontWeight: 600, flex: 1, fontSize: 14 }}>
          {reportMeta?.title ?? '研究报告中...'}
        </span>
        <Button size="small" icon={<DownloadOutlined />} onClick={handleDownload}>
          下载 HTML
        </Button>
        <Button size="small" icon={<ExpandAltOutlined />} onClick={handleOpenInNewTab}>
          新窗口打开
        </Button>
      </div>
      <iframe
        src={reportUrl}
        style={{ flex: 1, border: 'none', borderRadius: 0 }}
        sandbox="allow-scripts allow-same-origin"
        title="Agent Report"
      />
    </div>
  );
}
