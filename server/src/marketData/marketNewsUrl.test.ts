import { describe, expect, it } from 'vitest';
import { normalizeMarketNewsUrl } from './marketNewsUrl.js';

describe('normalizeMarketNewsUrl', () => {
  it('converts a CLS app share API link to the desktop article page', () => {
    expect(normalizeMarketNewsUrl(
      'https://api3.cls.cn/share/article/2436739?os=web&sv=7.7.5&app=',
    )).toBe('https://www.cls.cn/detail/2436739');
  });

  it('keeps normal CLS and third-party article links unchanged', () => {
    expect(normalizeMarketNewsUrl('https://www.cls.cn/detail/2436739'))
      .toBe('https://www.cls.cn/detail/2436739');
    expect(normalizeMarketNewsUrl('https://example.com/news/1'))
      .toBe('https://example.com/news/1');
  });
});
