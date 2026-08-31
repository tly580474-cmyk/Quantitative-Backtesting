import { useState } from 'react';
import { Button, Empty, Spin, Typography } from 'antd';
import { DownloadOutlined, ExpandAltOutlined, FileTextOutlined } from '@ant-design/icons';
import { API_BASE_URL } from '@/api/config';
import { getReportDownloadUrl } from './api';

const { Text } = Typography;

interface Props {
  reportUrl: string | null;
  reportMeta: { title: string; summary: string } | null;
  runId: string | null;
  /** 嵌入对话流模式：显示为紧凑卡片，点击后在新窗口查看完整报告 */
  embedded?: boolean;
}

export function AgentReportView({ reportUrl, reportMeta, runId, embedded = false }: Props) {
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
    if (!window.confirm('将下载为本地独立 HTML 文件。请仅在可信环境中打开，是否继续？')) return;
    const a = document.createElement('a');
    a.href = downloadUrl;
    a.download = `${reportMeta?.title ?? 'report'}.html`;
    a.click();
  };

  const handleOpenInNewTab = () => {
    window.open(reportUrl, '_blank');
  };

  // 嵌入模式：紧凑卡片，不在对话流内嵌iframe（太重且影响性能）
  if (embedded) {
    return (
      <div>
        <div
          style={{
            padding: '12px 16px',
            background: 'var(--wb-selected)',
            borderBottom: '1px solid var(--wb-border)',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <FileTextOutlined style={{ color: 'var(--wb-accent)', fontSize: 18 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--wb-accent)' }}>
              {reportMeta?.title ?? '研究报告中...'}
            </div>
            {reportMeta?.summary && (
              <Text
                type="secondary"
                style={{
                  fontSize: 12,
                  display: 'block',
                  marginTop: 2,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {reportMeta.summary}
              </Text>
            )}
          </div>
        </div>
        <div style={{ padding: '8px 16px', display: 'flex', flexWrap: 'wrap', gap: 8, background: 'var(--wb-surface)' }}>
          <Button
            size="small"
            type="primary"
            icon={<ExpandAltOutlined />}
            onClick={handleOpenInNewTab}
          >
            在新窗口查看
          </Button>
          <Button
            size="small"
            icon={<DownloadOutlined />}
            onClick={handleDownload}
          >
            下载 HTML
          </Button>
        </div>
      </div>
    );
  }

  // 独立模式：iframe 预览（保留给其他用途）
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
          sandbox=""
          title="万行智研报告"
          onLoad={() => setLoading(false)}
        />
      </div>
    </div>
  );
}
