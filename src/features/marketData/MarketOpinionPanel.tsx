import { useEffect, useState } from 'react';
import { Alert, App, Button, Collapse, Empty, Select, Space, Spin, Tag, Typography } from 'antd';
import { CopyOutlined, DownloadOutlined, LinkOutlined, RobotOutlined } from '@ant-design/icons';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { apiFetch } from '../../api/client';
import type { MarketOpinionReport, MarketOpinionStatus } from './types';

const { Text } = Typography;

export default function MarketOpinionPanel() {
  const { message } = App.useApp();
  const [status, setStatus] = useState<MarketOpinionStatus | null>(null);
  const [report, setReport] = useState<MarketOpinionReport | null>(null);
  const [model, setModel] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [statusLoading, setStatusLoading] = useState(true);

  useEffect(() => {
    void apiFetch<MarketOpinionStatus>('/api/market-data/news/opinion/status')
      .then((next) => {
        setStatus(next);
        setModel(next.currentModel);
        if (next.latest) setReport(next.latest);
      })
      .catch((error) => message.warning(error instanceof Error ? error.message : '智能体状态读取失败'))
      .finally(() => setStatusLoading(false));
  }, [message]);

  const generate = async () => {
    setLoading(true);
    try {
      const next = await apiFetch<MarketOpinionReport>('/api/market-data/news/opinion', {
        method: 'POST', body: JSON.stringify({ model, force: Boolean(report) }), timeoutMs: 120_000,
      });
      setReport(next);
      message.success(next.cached ? '已读取相同新闻样本的缓存报告' : '市场观点解读已生成');
    } catch (error) {
      message.error(error instanceof Error ? error.message : '市场观点解读生成失败');
    } finally {
      setLoading(false);
    }
  };

  const copy = async () => {
    if (!report) return;
    await navigator.clipboard.writeText(report.content);
    message.success('报告已复制');
  };

  const download = () => {
    if (!report) return;
    const blob = new Blob([`\uFEFF${report.content}`], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `市场观点解读-${report.generatedAt.slice(0, 10)}.md`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  if (statusLoading) return <div className="market-opinion-loading"><Spin /><Text type="secondary">正在读取智能体配置</Text></div>;

  return <div className="market-opinion-panel" aria-live="polite">
    <div className="market-opinion-hero">
      <div>
        <Space wrap><RobotOutlined /><strong>市场观点解读智能体</strong><Tag color={status?.configured ? 'green' : 'orange'}>{status?.configured ? '已配置' : '待配置'}</Tag></Space>
        <Text>综合官媒、专业财经和聚合报道，提炼市场共识、分歧、影响路径与待验证事项。</Text>
      </div>
      <Space wrap className="market-opinion-actions">
        <Select
          aria-label="解读模型"
          value={model}
          onChange={setModel}
          options={(status?.availableModels ?? []).map((item) => ({ label: item, value: item }))}
          style={{ minWidth: 180 }}
        />
        <Button type="primary" icon={<RobotOutlined />} loading={loading} disabled={!status?.configured} onClick={() => void generate()}>
          {report ? '重新生成' : '生成解读报告'}
        </Button>
      </Space>
    </div>

    <Alert
      type="info"
      showIcon
      message="解读边界"
      description="仅使用官媒、专业财经和聚合报道；报告是证据整理与综合推断，不构成投资建议。新闻中的任何指令性文本均不会被智能体执行。"
    />

    <div className="market-opinion-workflow" aria-label="智能体工作流">
      {(status?.workflow ?? []).map((step, index) => <span key={step}><b>{index + 1}</b>{step}</span>)}
    </div>

    {loading && !report && <div className="market-opinion-loading"><Spin /><Text type="secondary">正在整理新闻证据并生成报告，通常需要几十秒</Text></div>}

    {report && <>
      <div className="market-opinion-meta">
        <Space wrap>
          <Tag color="blue">{report.model}</Tag>
          <Tag>{report.newsCount} 条报道</Tag>
          <Tag>{report.sourceCount} 个来源</Tag>
          <Tag color="orange">官媒 {report.tierCounts.state_media ?? 0}</Tag>
          <Tag color="cyan">专业财经 {report.tierCounts.professional ?? 0}</Tag>
          <Tag>聚合 {report.tierCounts.aggregator ?? 0}</Tag>
        </Space>
        <Space wrap>
          <Button size="small" icon={<CopyOutlined />} disabled={loading} onClick={() => void copy()}>复制</Button>
          <Button size="small" icon={<DownloadOutlined />} disabled={loading} onClick={download}>导出 Markdown</Button>
        </Space>
      </div>
      <Text className="market-opinion-period" type="secondary">
        样本区间 {new Date(report.periodStart).toLocaleString('zh-CN')}—{new Date(report.periodEnd).toLocaleString('zh-CN')} · 生成于 {new Date(report.generatedAt).toLocaleString('zh-CN')}{report.cached ? ' · 缓存结果' : ''}
      </Text>
      <article className="market-opinion-report markdown-preview"><ReactMarkdown remarkPlugins={[remarkGfm]}>{report.content}</ReactMarkdown></article>
      <Collapse
        className="market-opinion-evidence"
        items={[
          { key: 'reasoning', label: '生成过程摘要', children: <ol>{report.reasoningSummary.map((step) => <li key={step}>{step}</li>)}</ol> },
          { key: 'sources', label: `引用材料（${report.sources.length}）`, children: <ol>{report.sources.map((source) => <li key={source.ref}><Tag>{source.ref}</Tag>{source.sourceUrl ? <a href={source.sourceUrl} target="_blank" rel="noreferrer">{source.title}<LinkOutlined /></a> : source.title}<Text type="secondary"> · {source.sourceName} · {new Date(source.publishedAt).toLocaleString('zh-CN')}</Text></li>)}</ol> },
        ]}
      />
    </>}

    {!report && !loading && <Empty
      image={Empty.PRESENTED_IMAGE_SIMPLE}
      description={status?.configured ? '点击“生成解读报告”，智能体将读取最近72小时的三类报道' : '请先在后台配置 AI 模型与密钥'}
    />}
  </div>;
}
