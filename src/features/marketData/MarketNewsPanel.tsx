import { useEffect, useMemo, useState } from 'react';
import { App, Button, Empty, Segmented, Space, Spin, Switch, Tag, Tooltip, Typography } from 'antd';
import { LinkOutlined, NotificationOutlined, ReloadOutlined } from '@ant-design/icons';
import { apiFetch } from '../../api/client';
import type { MarketNewsItem, MarketNewsSnapshot, NewsSourceTier } from './types';
import MarketOpinionPanel from './MarketOpinionPanel';

const { Text } = Typography;
const STORAGE_KEY = 'quant-market-news-v1';

const tierMeta: Record<NewsSourceTier, { label: string; color?: string }> = {
  official: { label: '官方', color: 'red' },
  state_media: { label: '官媒', color: 'orange' },
  professional: { label: '专业财经', color: 'blue' },
  aggregator: { label: '聚合', color: undefined },
  self_media: { label: '自媒体', color: undefined },
};

const viewOptions = [
  { label: '全部', value: 'all' },
  { label: '市场观点解读', value: 'opinion' },
  { label: '官方', value: 'official' },
  { label: '官媒', value: 'state_media' },
  { label: '专业财经', value: 'professional' },
  { label: '聚合', value: 'aggregator' },
];

function readSnapshot(): MarketNewsSnapshot | null {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as MarketNewsSnapshot | null; } catch { return null; }
}

export default function MarketNewsPanel() {
  const { message } = App.useApp();
  const [snapshot, setSnapshot] = useState<MarketNewsSnapshot | null>(readSnapshot);
  const [tier, setTier] = useState<'all' | 'opinion' | NewsSourceTier>('all');
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const isOpinion = tier === 'opinion';

  const load = async (force = false, append = false) => {
    if (isOpinion) return;
    append ? setLoadingMore(true) : setLoading(true);
    try {
      const params = new URLSearchParams({ limit: '30' });
      if (tier !== 'all') params.set('tier', tier);
      if (force) params.set('force', 'true');
      if (append && snapshot?.nextCursor) {
        params.set('before', snapshot.nextCursor.before);
        if (snapshot.nextCursor.beforeId) params.set('beforeId', String(snapshot.nextCursor.beforeId));
      }
      const next = await apiFetch<MarketNewsSnapshot>(`/api/market-data/news/market?${params}`, { timeoutMs: 30_000 });
      const merged = append && snapshot
        ? { ...next, items: dedupe([...snapshot.items, ...next.items]), total: snapshot.items.length + next.items.length }
        : next;
      setSnapshot(merged);
      if (tier === 'all' && !append) localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
    } catch (error) {
      message.warning(error instanceof Error ? error.message : '市场资讯刷新失败，继续展示缓存');
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  };

  useEffect(() => { if (!snapshot) void load(false, false); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!isOpinion && (tier !== 'all' || snapshot)) void load(false, false); }, [tier]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!autoRefresh || isOpinion) return;
    const timer = window.setInterval(() => void load(true, false), 3 * 60_000);
    return () => window.clearInterval(timer);
  }, [autoRefresh, tier, snapshot?.nextCursor?.before]); // eslint-disable-line react-hooks/exhaustive-deps

  const groups = useMemo(() => groupByDate(snapshot?.items ?? []), [snapshot]);

  return <section className="market-news-panel" aria-label="市场消息面">
    <div className="market-intelligence-toolbar">
      <div><strong><NotificationOutlined /> 市场消息面</strong><Text type="secondary">{isOpinion ? '智能体基于三类新闻证据生成结构化市场解读' : '按发布时间倒序，来源等级用于可信度标识'}</Text></div>
      <Space wrap>
        <Segmented
          value={tier}
          onChange={(value) => setTier(value as typeof tier)}
          options={viewOptions}
        />
        {!isOpinion && <><Tooltip title="每 3 分钟自动刷新"><Space size={4}><Switch size="small" checked={autoRefresh} onChange={setAutoRefresh} aria-label="自动刷新市场资讯" /><Text type="secondary">自动</Text></Space></Tooltip>
        <Button icon={<ReloadOutlined />} loading={loading} aria-label="刷新市场资讯" onClick={() => void load(true, false)} /></>}
      </Space>
    </div>
    {isOpinion ? <MarketOpinionPanel /> : <>
    <Spin spinning={loading && !snapshot}>
      <div className="market-news-feed" aria-live="polite">
        {groups.map(([date, items]) => <div className="market-news-day" key={date}>
          <div className="market-news-date"><span>{date}</span><i /></div>
          {items.map((item) => <article className="market-news-item" key={`${item.sourceKey}-${item.newsId}`}>
            <time dateTime={item.publishedAt}>{new Date(item.publishedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time>
            <div>
              <Space size={[6, 4]} wrap><Tag color={tierMeta[item.sourceTier].color}>{tierMeta[item.sourceTier].label}</Tag><Tag>{item.sourceName}</Tag>{(item.sourceCount ?? 1) > 1 && <Tooltip title={`同一事件来源：${item.relatedSources?.map((source) => source.sourceName).join('、')}`}><Tag color="cyan">{item.sourceCount} 个来源</Tag></Tooltip>}{item.securityCode && <Tag color="geekblue">{item.securityCode}</Tag>}</Space>
              <h3>{item.sourceUrl ? <a href={item.sourceUrl} target="_blank" rel="noreferrer">{item.title}<LinkOutlined /></a> : item.title}</h3>
              {item.summary && <p>{item.summary}</p>}
            </div>
          </article>)}
        </div>)}
        {!groups.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={loading ? '正在加载市场资讯' : '暂无符合条件的市场资讯'} />}
      </div>
    </Spin>
    {snapshot?.nextCursor && snapshot.items.length > 0 && <div className="market-news-more"><Button loading={loadingMore} onClick={() => void load(false, true)}>加载更多</Button></div>}
    {snapshot && <Text className="market-news-updated" type="secondary">更新于 {new Date(snapshot.updatedAt).toLocaleString('zh-CN')} · 来源 {snapshot.sources.join('、') || '—'}{snapshot.stale ? ' · 缓存数据' : ''}</Text>}
    </>}
  </section>;
}

function dedupe(items: MarketNewsItem[]): MarketNewsItem[] {
  const groups = new Map<string, MarketNewsItem[]>();
  for (const item of items) {
    const key = item.canonicalHash || `${item.sourceKey}:${item.newsId}`;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return [...groups.values()].map((group) => {
    if (group.length === 1) return group[0]!;
    const sources = [...new Map(group.flatMap((item) => item.relatedSources ?? [{
      newsId: item.newsId, sourceKey: item.sourceKey, sourceName: item.sourceName,
      sourceTier: item.sourceTier, sourceUrl: item.sourceUrl, publishedAt: item.publishedAt,
    }]).map((source) => [`${source.sourceKey}:${source.sourceName}`, source])).values()];
    return { ...group[0]!, sourceCount: sources.length, relatedSources: sources };
  }).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
}

function groupByDate(items: MarketNewsItem[]): Array<[string, MarketNewsItem[]]> {
  const result = new Map<string, MarketNewsItem[]>();
  for (const item of items) {
    const date = new Date(item.publishedAt).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' });
    result.set(date, [...(result.get(date) ?? []), item]);
  }
  return [...result.entries()];
}
