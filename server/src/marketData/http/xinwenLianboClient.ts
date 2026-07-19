import { limitedFetchText } from './eastmoneyClient.js';
import { parseXinwenLianboHtml } from '../xinwenLianboParser.js';
import type { MarketNewsItem } from '../marketNewsTypes.js';

const BASE_URL = 'https://cn.govopendata.com/xinwenlianbo';
const CACHE_MS = 15 * 60_000;
let cache: { items: MarketNewsItem[]; cachedAt: number } | null = null;

export async function fetchXinwenLianbo(now = new Date()): Promise<MarketNewsItem[]> {
  if (cache && now.getTime() - cache.cachedAt < CACHE_MS) return cache.items;
  const shanghaiNow = new Date(now.getTime() + 8 * 60 * 60_000);
  const startOffset = shanghaiNow.getUTCHours() >= 20 ? 0 : 1;
  let lastError: unknown;
  for (let offset = startOffset; offset < startOffset + 3; offset += 1) {
    const date = new Date(shanghaiNow.getTime() - offset * 86_400_000).toISOString().slice(0, 10);
    try {
      const html = await limitedFetchText(`${BASE_URL}/${date.replace(/-/g, '')}/`, {
        referer: `${BASE_URL}/`, timeoutMs: 20_000,
        headers: { Accept: 'text/html,application/xhtml+xml' },
      });
      const items = parseXinwenLianboHtml(html, date);
      if (!items.length) throw new Error(`${date} 新闻联播页面没有可用文稿`);
      cache = { items, cachedAt: now.getTime() };
      return items;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('新闻联播文字稿不可用');
}

export function clearXinwenLianboCache(): void {
  cache = null;
}
