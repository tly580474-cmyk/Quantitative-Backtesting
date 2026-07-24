import { describe, expect, it } from 'vitest';
import { normalizeNewsUrl } from './newsUrl';

describe('normalizeNewsUrl', () => {
  it('rewrites cached CLS app share links', () => {
    expect(normalizeNewsUrl('https://api3.cls.cn/share/article/2436739?os=web&sv=7.7.5&app='))
      .toBe('https://www.cls.cn/detail/2436739');
  });

  it('does not rewrite unrelated links', () => {
    expect(normalizeNewsUrl('https://example.com/article/1'))
      .toBe('https://example.com/article/1');
  });
});
