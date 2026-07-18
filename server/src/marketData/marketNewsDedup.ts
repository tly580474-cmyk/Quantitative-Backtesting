import { createHash } from 'node:crypto';
import { TIER_PRIORITY, type MarketNewsItem, type MarketNewsSource } from './marketNewsTypes.js';

const EVENT_WINDOW_MS = 6 * 60 * 60_000;
const EXACT_TITLE_WINDOW_MS = 36 * 60 * 60_000;
const SIMILARITY_THRESHOLD = 0.64;

export function buildCanonicalNewsHash(title: string, publishedAt: string): string {
  return hash(`${normalizeEventTitle(title)}|${shanghaiDate(publishedAt)}`);
}

export function clusterMarketNews(items: MarketNewsItem[]): MarketNewsItem[] {
  const clusters: MarketNewsItem[][] = [];
  for (const item of [...items].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))) {
    const cluster = clusters.find((candidate) => sameNewsEvent(item, candidate[0]!));
    if (cluster) cluster.push(item);
    else clusters.push([item]);
  }
  return clusters.map(mergeCluster).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
}

export function sameNewsEvent(left: MarketNewsItem, right: MarketNewsItem): boolean {
  if (left.contentType === 'announcement' || right.contentType === 'announcement') {
    return left.contentType === right.contentType && left.canonicalHash === right.canonicalHash;
  }
  if (left.securityCode && right.securityCode && left.securityCode !== right.securityCode) return false;
  const distance = Math.abs(Date.parse(left.publishedAt) - Date.parse(right.publishedAt));
  const leftTitle = normalizeEventTitle(left.title);
  const rightTitle = normalizeEventTitle(right.title);
  if (!leftTitle || !rightTitle) return false;
  if (leftTitle === rightTitle) return distance <= EXACT_TITLE_WINDOW_MS;
  if (distance > EVENT_WINDOW_MS || Math.min(leftTitle.length, rightTitle.length) < 8) return false;
  if (hasConflictingNumericFacts(leftTitle, rightTitle)) return false;
  const commonRun = longestCommonSubstring(leftTitle, rightTitle);
  if (commonRun >= Math.max(6, Math.ceil(Math.min(leftTitle.length, rightTitle.length) * 0.35))) return true;
  return diceCoefficient(bigrams(leftTitle), bigrams(rightTitle)) >= SIMILARITY_THRESHOLD;
}

function mergeCluster(items: MarketNewsItem[]): MarketNewsItem {
  const primary = [...items].sort((a, b) => {
    const tier = TIER_PRIORITY[a.sourceTier] - TIER_PRIORITY[b.sourceTier];
    if (tier) return tier;
    const completeness = itemCompleteness(b) - itemCompleteness(a);
    return completeness || a.publishedAt.localeCompare(b.publishedAt);
  })[0]!;
  const relatedSources = uniqueSources(items.flatMap((item) => item.relatedSources?.length
    ? item.relatedSources
    : [toSource(item)]));
  return {
    ...primary,
    canonicalHash: buildCanonicalNewsHash(primary.title, primary.publishedAt),
    relatedSources,
    sourceCount: relatedSources.length,
  };
}

function uniqueSources(sources: MarketNewsSource[]): MarketNewsSource[] {
  return [...new Map(sources.map((source) => [`${source.sourceKey}:${source.sourceName}`, source])).values()]
    .sort((a, b) => TIER_PRIORITY[a.sourceTier] - TIER_PRIORITY[b.sourceTier] || a.publishedAt.localeCompare(b.publishedAt));
}

function toSource(item: MarketNewsItem): MarketNewsSource {
  return {
    newsId: item.newsId,
    sourceKey: item.sourceKey,
    sourceName: item.sourceName,
    sourceTier: item.sourceTier,
    sourceUrl: item.sourceUrl,
    publishedAt: item.publishedAt,
  };
}

function itemCompleteness(item: MarketNewsItem): number {
  return (item.sourceUrl ? 20 : 0) + (item.securityCode ? 15 : 0)
    + Math.min(30, (item.content?.length ?? 0) / 100)
    + Math.min(20, (item.summary?.length ?? 0) / 50);
}

function normalizeEventTitle(value: string): string {
  return value.toLowerCase()
    .replace(/^(?:快讯|消息|最新)[:：丨|\s-]*/u, '')
    .replace(/[\s，。！？、；：,.!?;:'"“”‘’（）()【】\[\]《》<>·—_-]/g, '');
}

function hasConflictingNumericFacts(left: string, right: string): boolean {
  const leftFacts = numericFacts(left);
  const rightFacts = numericFacts(right);
  if (!leftFacts.size || !rightFacts.size) return false;
  const leftOnly = [...leftFacts].some((fact) => !rightFacts.has(fact));
  const rightOnly = [...rightFacts].some((fact) => !leftFacts.has(fact));
  return leftOnly && rightOnly;
}

function numericFacts(value: string): Set<string> {
  return new Set(value.match(/[a-z]+\d+|\d+(?:\.\d+)?(?:%|万|亿|架|列|个|家)?/g) ?? []);
}

function bigrams(value: string): Set<string> {
  const result = new Set<string>();
  for (let index = 0; index < value.length - 1; index += 1) result.add(value.slice(index, index + 2));
  return result;
}

function diceCoefficient(left: Set<string>, right: Set<string>): number {
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  return 2 * intersection / (left.size + right.size);
}

function longestCommonSubstring(left: string, right: string): number {
  const previous = new Array<number>(right.length + 1).fill(0);
  let maximum = 0;
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    for (let rightIndex = right.length; rightIndex >= 1; rightIndex -= 1) {
      previous[rightIndex] = left[leftIndex - 1] === right[rightIndex - 1] ? previous[rightIndex - 1]! + 1 : 0;
      maximum = Math.max(maximum, previous[rightIndex]!);
    }
  }
  return maximum;
}

function shanghaiDate(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp + 8 * 60 * 60_000).toISOString().slice(0, 10) : '1970-01-01';
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
