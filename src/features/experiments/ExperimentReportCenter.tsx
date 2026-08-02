import { useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Alert, App, Button, Empty, List, Space, Spin, Tag, Typography } from 'antd';
import { DownloadOutlined, FilePdfOutlined, GlobalOutlined, ReloadOutlined } from '@ant-design/icons';
import {
  enqueueExperimentReportArtifact,
  experimentReportArtifactDownloadUrl,
  getExperimentReportWorkerStatus,
  listExperimentReportHistory,
} from './api';
import type { ExperimentArtifactJob, ExperimentReportHistoryItem, ExperimentReportWorkerStatus } from './types';

const { Text, Title } = Typography;

function artifactFor(item: ExperimentReportHistoryItem, format: 'html' | 'pdf') {
  return item.artifacts.find((artifact) => artifact.format === format);
}

function ArtifactAction({
  item, format, onChanged,
}: {
  item: ExperimentReportHistoryItem;
  format: 'html' | 'pdf';
  onChanged: () => Promise<void>;
}) {
  const { message } = App.useApp();
  const [submitting, setSubmitting] = useState(false);
  const artifact = artifactFor(item, format);
  const pending = artifact?.status === 'queued' || artifact?.status === 'running';
  const label = format === 'pdf' ? 'PDF' : 'HTML';
  if (artifact?.status === 'completed') {
    return (
      <Button
        size="small"
        icon={<DownloadOutlined />}
        href={experimentReportArtifactDownloadUrl(artifact.id)}
      >
        下载 {label}
      </Button>
    );
  }
  return (
    <Button
      size="small"
      icon={format === 'pdf' ? <FilePdfOutlined /> : <GlobalOutlined />}
      loading={submitting || pending}
      disabled={pending}
      onClick={async () => {
        setSubmitting(true);
        try {
          await enqueueExperimentReportArtifact(item.run.id, format);
          message.success(`${label} 已进入独立渲染队列`);
          await onChanged();
        } catch (error) {
          message.error(error instanceof Error ? error.message : `${label} 入队失败`);
        } finally {
          setSubmitting(false);
        }
      }}
    >
      {artifact?.status === 'failed' ? `重试 ${label}` : pending ? `${label} 生成中` : `生成 ${label}`}
    </Button>
  );
}

export default function ExperimentReportCenter() {
  const [items, setItems] = useState<ExperimentReportHistoryItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [workerStatus, setWorkerStatus] = useState<ExperimentReportWorkerStatus | null>(null);

  const load = async () => {
    try {
      const [next, status] = await Promise.all([
        listExperimentReportHistory(),
        getExperimentReportWorkerStatus().catch(() => null),
      ]);
      setItems(next);
      setWorkerStatus(status);
      setSelectedId((current) => current && next.some((item) => item.report.id === current)
        ? current
        : next[0]?.report.id ?? null);
      setError(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '历史实验报告读取失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const hasPending = items.some((item) => item.artifacts.some((artifact) => artifact.status === 'queued' || artifact.status === 'running'));
  useEffect(() => {
    if (!hasPending) return;
    const timer = window.setInterval(() => { void load(); }, 1500);
    return () => window.clearInterval(timer);
  }, [hasPending]); // eslint-disable-line react-hooks/exhaustive-deps

  const selected = useMemo(
    () => items.find((item) => item.report.id === selectedId) ?? null,
    [items, selectedId],
  );

  if (loading) return <div className="experiment-report-center-loading"><Spin tip="读取历史报告" /></div>;
  if (error && items.length === 0) return <Alert type="error" message="报告中心不可用" description={error} showIcon />;
  if (items.length === 0) return <Empty description="暂无 M3 实验报告；从冻结实验版本运行回测后会自动归档" />;

  return (
    <div className="experiment-report-center">
      <aside className="experiment-report-history">
        <div className="experiment-report-center-toolbar">
          <div>
            <Text strong>历史报告 · {items.length}</Text>
            {workerStatus && (
              <Tag color={workerStatus.healthy ? 'success' : 'error'} style={{ marginInlineStart: 8 }}>
                Worker {workerStatus.healthy ? '在线' : '离线'} · 排队 {workerStatus.queue.queued}
              </Tag>
            )}
          </div>
          <Button size="small" icon={<ReloadOutlined />} onClick={() => void load()}>刷新</Button>
        </div>
        <List
          dataSource={items}
          renderItem={(item) => (
            <List.Item
              className={item.report.id === selectedId ? 'is-active' : ''}
              onClick={() => setSelectedId(item.report.id)}
            >
              <List.Item.Meta
                title={<Text strong ellipsis>{item.experiment.name}</Text>}
                description={(
                  <Space direction="vertical" size={2}>
                    <Text type="secondary">{item.result?.datasetSnapshot?.symbol ?? '未知标的'} · v{item.version.version}</Text>
                    <Text type="secondary">{new Date(item.report.createdAt).toLocaleString('zh-CN')}</Text>
                    <Space size={4} wrap>
                      <Tag color={item.run.validationStatus === 'candidate' ? 'success' : item.run.validationStatus === 'rejected' ? 'error' : 'warning'}>
                        {item.run.validationStatus === 'candidate' ? '候选' : item.run.validationStatus === 'rejected' ? '拒绝' : '待验证'}
                      </Tag>
                      {item.artifacts.map((artifact) => (
                        <Tag key={artifact.id} color={artifact.status === 'completed' ? 'blue' : artifact.status === 'failed' ? 'red' : 'processing'}>
                          {artifact.format.toUpperCase()} {artifact.status}
                        </Tag>
                      ))}
                    </Space>
                  </Space>
                )}
              />
            </List.Item>
          )}
        />
      </aside>
      <main className="experiment-report-detail">
        {selected && (
          <>
            <div className="experiment-report-detail-head">
              <div>
                <Title level={4}>{selected.experiment.name}</Title>
                <Text type="secondary">报告哈希 {selected.report.reportHash.slice(0, 12)} · 模板 {selected.report.templateVersion}</Text>
              </div>
              <Space wrap>
                <ArtifactAction item={selected} format="html" onChanged={load} />
                <ArtifactAction item={selected} format="pdf" onChanged={load} />
              </Space>
            </div>
            {selected.artifacts.filter((artifact) => artifact.status === 'failed').map((artifact: ExperimentArtifactJob) => (
              <Alert
                key={artifact.id}
                type="error"
                showIcon
                message={`${artifact.format.toUpperCase()} 生成失败`}
                description={artifact.errorMessage || '独立 Worker 未返回详细错误'}
              />
            ))}
            <article className="experiment-report-markdown markdown-preview">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{selected.report.markdown}</ReactMarkdown>
            </article>
          </>
        )}
      </main>
    </div>
  );
}
