import { fetchCachedMarketSentimentOverview, fetchMarketIndexQuotes } from '../marketData/aStockDataService.js';
import { fetchCachedHotSectors } from '../marketData/hotSectorService.js';
import { getMarketOpinionNews, refreshMarketNews } from '../marketData/marketNewsService.js';
import { getChinaMarketSession } from '../marketData/jobs/marketSession.js';
import { EmailSender, reportEmailHtml } from './emailSender.js';
import { MarketOpinionAgent, type MarketOpinionDigestKind, type MarketOpinionMarketContext, type MarketOpinionReport } from './marketOpinionAgent.js';

export interface MarketOpinionPushResult {
  kind: MarketOpinionDigestKind;
  subject: string;
  generatedAt: string;
  newsCount: number;
  sourceCount: number;
  messageId: string;
}

export interface MarketOpinionPushStatus {
  enabled: boolean;
  configured: boolean;
  schedules: Record<MarketOpinionDigestKind, string>;
  recipients: number;
  running: boolean;
  lastSuccess?: MarketOpinionPushResult;
  lastError?: { at: string; kind: MarketOpinionDigestKind; message: string };
}

export class MarketOpinionPushService {
  private running = false;
  private lastSuccess?: MarketOpinionPushResult;
  private lastError?: MarketOpinionPushStatus['lastError'];

  constructor(
    private options: {
      enabled: boolean;
      schedules: Record<MarketOpinionDigestKind, string>;
      recipientCount: number;
      agent: MarketOpinionAgent;
      email: EmailSender;
      model: string;
    },
  ) {}

  status(): MarketOpinionPushStatus {
    return {
      enabled: this.options.enabled,
      configured: this.options.email.isConfigured(),
      schedules: this.options.schedules,
      recipients: this.options.recipientCount,
      running: this.running,
      lastSuccess: this.lastSuccess,
      lastError: this.lastError,
    };
  }

  async send(kind: MarketOpinionDigestKind, now = new Date()): Promise<MarketOpinionPushResult> {
    if (this.running) throw new Error('已有市场观点邮件正在生成');
    this.running = true;
    try {
      await refreshMarketNews(true, 50).catch(() => undefined);
      const [news, context] = await Promise.all([getMarketOpinionNews(), buildMarketContext(now)]);
      const report = await this.options.agent.generateDigest(news, kind, context, this.options.model);
      const subject = buildSubject(kind, context);
      const emailMarkdown = appendReferenceArticles(report);
      const result = await this.options.email.send({
        subject,
        text: `${subject}\n\n${emailMarkdown}\n\n生成时间：${formatShanghai(report.generatedAt)}`,
        html: reportEmailHtml(subject, emailMarkdown, formatShanghai(report.generatedAt)),
      });
      const pushResult = summarizeResult(kind, subject, report, result.messageId);
      this.lastSuccess = pushResult;
      return pushResult;
    } catch (error) {
      this.lastError = { at: new Date().toISOString(), kind, message: error instanceof Error ? error.message : String(error) };
      throw error;
    } finally {
      this.running = false;
    }
  }
}

export function appendReferenceArticles(report: MarketOpinionReport): string {
  const cited = new Set(Array.from(report.content.matchAll(/\[(N\d+)\]/g), (match) => match[1]));
  const sources = report.sources
    .filter((source) => cited.has(source.ref))
    .sort((left, right) => Number(left.ref.slice(1)) - Number(right.ref.slice(1)));
  if (!sources.length) return report.content;
  const lines = sources.map((source) => {
    const title = escapeMarkdownLabel(source.title);
    const metadata = `${source.sourceName} · ${formatShanghai(source.publishedAt)}`;
    const url = safeArticleUrl(source.sourceUrl);
    return url
      ? `- **[${source.ref}] ${title}**  \n  ${metadata} · [阅读全文](${url})`
      : `- **[${source.ref}] ${title}**  \n  ${metadata} · 原始来源未提供可访问链接`;
  });
  return `${report.content.trim()}\n\n---\n\n## 参考文章\n\n文中的 N 编号对应以下原始报道：\n\n${lines.join('\n')}`;
}

function safeArticleUrl(value?: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return encodeURI(url.toString()).replace(/\(/g, '%28').replace(/\)/g, '%29');
  } catch {
    return null;
  }
}

function escapeMarkdownLabel(value: string): string {
  return value.replace(/([\\[\]*_`])/g, '\\$1');
}

async function buildMarketContext(now: Date): Promise<MarketOpinionMarketContext> {
  const session = getChinaMarketSession(now);
  const [indices, sentiment, hotSectors] = await Promise.allSettled([
    fetchMarketIndexQuotes(),
    fetchCachedMarketSentimentOverview(true),
    fetchCachedHotSectors(true),
  ]);
  const unavailable: string[] = [];
  if (indices.status === 'rejected') unavailable.push('指数行情');
  if (sentiment.status === 'rejected') unavailable.push('市场情绪与涨跌分布');
  if (hotSectors.status === 'rejected') unavailable.push('热点板块');
  return {
    capturedAt: now.toISOString(),
    session: `${session.tradeDate} ${session.phase}`,
    indices: indices.status === 'fulfilled' ? indices.value.map((item) => ({
      code: item.code, name: item.name, price: item.price, changePct: item.changePct,
      open: item.open, high: item.high, low: item.low, amountWan: item.amountWan, updatedAt: item.updatedAt,
    })) : undefined,
    sentiment: sentiment.status === 'fulfilled' ? {
      updatedAt: sentiment.value.updatedAt,
      total: sentiment.value.total,
      advancers: sentiment.value.advancers,
      decliners: sentiment.value.decliners,
      flat: sentiment.value.flat,
      upLimit: sentiment.value.upLimit,
      downLimit: sentiment.value.downLimit,
      totalAmountYi: sentiment.value.totalAmountYi,
      mainNetInYi: sentiment.value.mainNetInYi,
      msi: sentiment.value.msi,
      status: sentiment.value.statusLabel,
      structure: sentiment.value.structureLabel,
      divergence: sentiment.value.breadthIndexDivergence,
      notes: sentiment.value.notes,
    } : undefined,
    hotSectors: hotSectors.status === 'fulfilled' ? hotSectors.value.items.slice(0, 10).map((item) => ({
      rank: item.rank, code: item.code, name: item.name, changePct: item.changePct,
      mainNetInYi: item.mainNetInYi, breadthPct: item.breadthPct, leadingStock: item.leadingStock, signals: item.signals,
    })) : undefined,
    unavailable,
  };
}

function buildSubject(kind: MarketOpinionDigestKind, context: MarketOpinionMarketContext): string {
  const label = { morning: '消息早报', midday: '财经午报', close: '盘后总结' }[kind];
  return `【市场观点智能体】${context.session.slice(0, 10)} ${label}`;
}

function summarizeResult(kind: MarketOpinionDigestKind, subject: string, report: MarketOpinionReport, messageId: string): MarketOpinionPushResult {
  return { kind, subject, generatedAt: report.generatedAt, newsCount: report.newsCount, sourceCount: report.sourceCount, messageId };
}

function formatShanghai(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(value));
}
