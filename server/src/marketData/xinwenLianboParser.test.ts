import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseXinwenLianboHtml } from './xinwenLianboParser.js';

describe('新闻联播文字稿 parser', () => {
  it('maps daily sections as state-media news and filters placeholder titles', async () => {
    const root = process.cwd().replace(/[\\/]server$/, '') === process.cwd() ? resolve(process.cwd(), 'server') : process.cwd();
    const html = await readFile(resolve(root, 'src/marketData/fixtures/xinwen-lianbo.html'), 'utf8');
    const items = parseXinwenLianboHtml(html, '2026-07-18');
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      newsId: '2026-07-18:section-1001', sourceKey: 'xinwenlianbo', sourceTier: 'state_media',
      publishedAt: '2026-07-18T11:00:00.000Z',
    });
    expect(items[0]?.sourceUrl).toBe('https://cn.govopendata.com/xinwenlianbo/20260718/#section-1001');
    expect(items.some((item) => item.title.includes('对不起'))).toBe(false);
  });
});
