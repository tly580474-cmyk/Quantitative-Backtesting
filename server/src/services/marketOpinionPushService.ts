import { fetchCachedMarketSentimentOverview, fetchMarketIndexQuotes } from '../marketData/aStockDataService.js';
import { fetchCachedHotSectors } from '../marketData/hotSectorService.js';
import { fetchCachedMarketCapitalFlow } from '../marketData/marketCapitalFlowService.js';
import { getDataFreshness } from '../marketData/repositories/marketDataRepository.js';
import { getMarketOpinionNews, refreshMarketNews } from '../marketData/marketNewsService.js';
import { getChinaMarketSession, type ChinaMarketSession } from '../marketData/jobs/marketSession.js';
import { EmailSender, reportEmailHtml } from './emailSender.js';
import { MarketOpinionAgent, type MarketOpinionDigestKind, type MarketOpinionMarketContext, type MarketOpinionReport } from './marketOpinionAgent.js';
import { assessOpinionNews } from './marketOpinionNewsRanker.js';
import {
  assertFreshMarketOpinionInputs,
  DEFAULT_MARKET_OPINION_FRESHNESS_POLICY,
  formatMarketOpinionFreshnessEvidence,
  type FreshMarketOpinionInputs,
  type MarketOpinionFreshnessPolicy,
} from './marketOpinionFreshness.js';

export interface MarketOpinionPushResult {
  kind: MarketOpinionDigestKind;
  subject: string;
  generatedAt: string;
  newsCount: number;
  sourceCount: number;
  messageId: string;
  newsFetchedAt: string;
  marketCapturedAt: string;
  newsSources: string[];
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

export type MarketOpinionPushStage = 'refreshing' | 'generating' | 'sending' | 'sent';

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
      freshnessPolicy?: MarketOpinionFreshnessPolicy;
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

  async send(
    kind: MarketOpinionDigestKind,
    now = new Date(),
    sendOptions: {
      subjectPrefix?: string;
      onStage?: (stage: MarketOpinionPushStage) => void | Promise<void>;
    } = {},
  ): Promise<MarketOpinionPushResult> {
    if (this.running) throw new Error('已有市场观点邮件正在生成');
    this.running = true;
    try {
      await sendOptions.onStage?.('refreshing');
      const inputs = await withStageTimeout(
        collectFreshMarketOpinionInputs(now, this.options.freshnessPolicy),
        120_000,
        '观点推送数据准备超过 120 秒',
      );
      await sendOptions.onStage?.('generating');
      const report = await withStageTimeout(
        this.options.agent.generateDigest(inputs.news, kind, inputs.context, this.options.model),
        90_000,
        '观点智能体生成超过 90 秒',
      );
      const subject = `${sendOptions.subjectPrefix ?? ''}${buildSubject(kind, inputs.context)}`;
      const emailMarkdown = `${appendReferenceArticles(report)}\n\n---\n\n${formatSelectionEvidence(report, inputs)}\n\n${formatMarketOpinionFreshnessEvidence(inputs)}`;
      await sendOptions.onStage?.('sending');
      const result = await withStageTimeout(
        this.options.email.send({
          subject,
          text: `${subject}\n\n${emailMarkdown}\n\n生成时间：${formatShanghai(report.generatedAt)}`,
          html: reportEmailHtml(subject, emailMarkdown, formatShanghai(report.generatedAt)),
        }),
        45_000,
        '观点邮件投递超过 45 秒',
      );
      await sendOptions.onStage?.('sent');
      const pushResult = summarizeResult(kind, subject, report, result.messageId, inputs);
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

export async function withStageTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), Math.max(1, timeoutMs));
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function collectFreshMarketOpinionInputs(
  now = new Date(),
  policy: MarketOpinionFreshnessPolicy = DEFAULT_MARKET_OPINION_FRESHNESS_POLICY,
  dependencies: {
    refreshNews?: typeof refreshMarketNews;
    loadRecentNews?: typeof getMarketOpinionNews;
    buildContext?: typeof buildMarketContext;
  } = {},
): Promise<FreshMarketOpinionInputs> {
  const newsSnapshot = await (dependencies.refreshNews ?? refreshMarketNews)(true, 50);
  const [news, context] = await Promise.all([
    (dependencies.loadRecentNews ?? getMarketOpinionNews)(now.getTime(), 72),
    (dependencies.buildContext ?? buildMarketContext)(now),
  ]);
  const inputs = { news, newsSnapshot, context };
  assertFreshMarketOpinionInputs(inputs, new Date(), policy);
  return inputs;
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

export function formatSelectionEvidence(report: MarketOpinionReport, inputs: FreshMarketOpinionInputs): string {
  const selected = report.sources.map((source) => inputs.news.find((item) => item.title === source.title
    && item.sourceName === source.sourceName && item.publishedAt === source.publishedAt)).filter((item) => item !== undefined);
  const assessments = selected.map((item) => assessOpinionNews(item));
  const scores = assessments.map((item) => item.score);
  const categories = assessments.reduce<Record<string, number>>((counts, item) => ({
    ...counts,
    [item.category]: (counts[item.category] ?? 0) + 1,
  }), {});
  return [
    '## 新闻筛选摘要',
    '',
    `- 原始候选：${inputs.news.length} 条；高价值事件：${report.newsCount} 条`,
    `- 入选规则：价值分不低于 60，最多 18 条，并限制主题与单一来源占比`,
    `- 入选分数：${scores.length ? `${Math.min(...scores)}–${Math.max(...scores)}` : '无'}`,
    `- 主题分布：${Object.entries(categories).map(([category, count]) => `${category} ${count}`).join('、') || '无'}`,
  ].join('\n');
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

export async function buildMarketContext(now: Date): Promise<MarketOpinionMarketContext> {
  const session = getChinaMarketSession(now);
  const freshness = await getDataFreshness().catch(() => null);
  const referenceTradeDate = resolveReferenceTradeDate(freshness?.latestTradeDate, session.tradeDate);
  const semantics = getMarketSnapshotSemantics(session, referenceTradeDate);
  const [indices, sentiment, capitalFlow, hotSectors] = await Promise.allSettled([
    fetchMarketIndexQuotes(),
    fetchCachedMarketSentimentOverview(true),
    fetchCachedMarketCapitalFlow(true, semantics.quoteTradeDate),
    fetchCachedHotSectors(true),
  ]);
  const unavailable: string[] = [];
  if (indices.status === 'rejected') unavailable.push('指数行情');
  if (sentiment.status === 'rejected') unavailable.push('市场情绪与涨跌分布');
  if (capitalFlow.status === 'rejected') unavailable.push('全市场主力资金');
  if (hotSectors.status === 'rejected') unavailable.push('热点板块');
  return {
    capturedAt: new Date().toISOString(),
    session: `${session.tradeDate} ${session.phase}`,
    sessionTradeDate: session.tradeDate,
    marketPhase: session.phase,
    referenceTradeDate,
    dataTradeDate: referenceTradeDate,
    indices: indices.status === 'fulfilled' ? indices.value.map((item) => ({
      code: item.code, name: item.name, price: item.price, changePct: item.changePct,
      quoteTradeDate: semantics.quoteTradeDate,
      quotePhase: semantics.quotePhase,
      snapshotType: semantics.snapshotType,
      previousClose: item.previousClose,
      previousCloseTradeDate: referenceTradeDate,
      open: item.open, high: item.high, low: item.low, amountWan: item.amountWan,
      updatedAt: item.updatedAt, source: item.source,
    })) : undefined,
    sentiment: sentiment.status === 'fulfilled' ? {
      snapshotTradeDate: inferSnapshotTradeDate(sentiment.value.updatedAt, semantics),
      snapshotPhase: semantics.quotePhase,
      snapshotType: semantics.snapshotType,
      updatedAt: sentiment.value.updatedAt,
      total: sentiment.value.total,
      advancers: sentiment.value.advancers,
      decliners: sentiment.value.decliners,
      flat: sentiment.value.flat,
      upLimit: sentiment.value.upLimit,
      downLimit: sentiment.value.downLimit,
      totalAmountYi: sentiment.value.totalAmountYi,
      mainNetInYi: sentiment.value.mainNetInYi,
      mainNetSampleCount: sentiment.value.mainNetSampleCount,
      msi: sentiment.value.msi,
      status: sentiment.value.statusLabel,
      structure: sentiment.value.structureLabel,
      divergence: sentiment.value.breadthIndexDivergence,
      notes: sentiment.value.notes,
    } : undefined,
    capitalFlow: capitalFlow.status === 'fulfilled' ? {
      ...capitalFlow.value,
      tradeDate: capitalFlow.value.stale
        ? capitalFlow.value.tradeDate ?? inferStoredSnapshotTradeDate(capitalFlow.value.updatedAt, referenceTradeDate)
        : semantics.quoteTradeDate,
      snapshotPhase: capitalFlow.value.stale ? 'cached_reference' : semantics.quotePhase,
      snapshotType: capitalFlow.value.stale ? 'cached_reference' : semantics.snapshotType,
    } : undefined,
    hotSectors: hotSectors.status === 'fulfilled' ? {
      dataTradeDate: hotSectors.value.stale
        ? inferStoredSnapshotTradeDate(hotSectors.value.updatedAt, referenceTradeDate)
        : semantics.quoteTradeDate,
      snapshotPhase: hotSectors.value.stale ? 'cached_reference' : semantics.quotePhase,
      snapshotType: hotSectors.value.stale ? 'cached_reference' : semantics.snapshotType,
      snapshotTime: hotSectors.value.updatedAt,
      source: hotSectors.value.source,
      stale: hotSectors.value.stale ?? false,
      fallbackReason: hotSectors.value.fallbackReason,
      items: hotSectors.value.items.slice(0, 10).map((item) => ({
        rank: item.rank, code: item.code, name: item.name, type: item.type, changePct: item.changePct,
        mainNetInYi: item.mainNetInYi, mainNetRatio: item.mainNetRatio, breadthPct: item.breadthPct,
        leadingStock: item.leadingStock, signals: item.signals,
      })),
    } : undefined,
    unavailable,
  };
}

export interface MarketSnapshotSemantics {
  quoteTradeDate: string | null;
  previousCloseTradeDate: string | null;
  quotePhase: 'market_closed' | 'pre_open_reference' | 'opening_auction' | 'continuous_trading' | 'lunch_break' | 'closing_settlement' | 'official_close';
  snapshotType: 'previous_close_reference' | 'current_session';
}

/**
 * Describes the ownership of a freshly fetched quote. In particular, data fetched
 * from 09:15 onward belongs to today's opening auction and must never be presented
 * as the previous trading day's close.
 */
export function getMarketSnapshotSemantics(
  session: ChinaMarketSession,
  referenceTradeDate: string | null,
): MarketSnapshotSemantics {
  if (session.phase === 'pre_open') {
    if (session.minuteOfDay >= 9 * 60 + 15) {
      return {
        quoteTradeDate: session.tradeDate,
        previousCloseTradeDate: referenceTradeDate,
        quotePhase: 'opening_auction',
        snapshotType: 'current_session',
      };
    }
    return {
      quoteTradeDate: referenceTradeDate,
      previousCloseTradeDate: referenceTradeDate,
      quotePhase: 'pre_open_reference',
      snapshotType: 'previous_close_reference',
    };
  }
  const phaseMap: Record<ChinaMarketSession['phase'], MarketSnapshotSemantics['quotePhase']> = {
    closed: 'market_closed',
    pre_open: 'pre_open_reference',
    morning: 'continuous_trading',
    lunch: 'lunch_break',
    afternoon: 'continuous_trading',
    settling: 'closing_settlement',
    final: 'official_close',
  };
  const currentSession = session.phase !== 'closed';
  return {
    quoteTradeDate: currentSession ? session.tradeDate : referenceTradeDate,
    previousCloseTradeDate: referenceTradeDate,
    quotePhase: phaseMap[session.phase],
    snapshotType: currentSession ? 'current_session' : 'previous_close_reference',
  };
}

function resolveReferenceTradeDate(latestTradeDate: string | null | undefined, sessionTradeDate: string): string {
  if (latestTradeDate && latestTradeDate < sessionTradeDate) return latestTradeDate;
  return previousWeekday(sessionTradeDate);
}

function inferSnapshotTradeDate(updatedAt: string, semantics: MarketSnapshotSemantics): string | null {
  return semantics.snapshotType === 'current_session'
    ? semantics.quoteTradeDate
    : inferShanghaiDate(updatedAt) ?? semantics.quoteTradeDate;
}

function inferStoredSnapshotTradeDate(updatedAt: string, referenceTradeDate: string | null): string | null {
  const timestamp = Date.parse(updatedAt);
  if (!Number.isFinite(timestamp)) return referenceTradeDate;
  return getMarketSnapshotSemantics(getChinaMarketSession(new Date(timestamp)), referenceTradeDate).quoteTradeDate;
}

function inferShanghaiDate(value: string): string | null {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(timestamp));
}

function previousWeekday(date: string): string {
  const value = new Date(`${date}T00:00:00+08:00`);
  do value.setUTCDate(value.getUTCDate() - 1);
  while ([0, 6].includes(value.getUTCDay()));
  return value.toISOString().slice(0, 10);
}

function buildSubject(kind: MarketOpinionDigestKind, context: MarketOpinionMarketContext): string {
  const label = { morning: '消息早报', midday: '财经午报', close: '盘后总结' }[kind];
  return `【市场观点智能体】${context.session.slice(0, 10)} ${label}`;
}

function summarizeResult(
  kind: MarketOpinionDigestKind,
  subject: string,
  report: MarketOpinionReport,
  messageId: string,
  inputs: FreshMarketOpinionInputs,
): MarketOpinionPushResult {
  return {
    kind,
    subject,
    generatedAt: report.generatedAt,
    newsCount: report.newsCount,
    sourceCount: report.sourceCount,
    messageId,
    newsFetchedAt: inputs.newsSnapshot.updatedAt,
    marketCapturedAt: inputs.context.capturedAt,
    newsSources: [...new Set(inputs.news.map((item) => item.sourceKey))],
  };
}

function formatShanghai(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(value));
}
