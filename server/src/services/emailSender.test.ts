import { describe, expect, it } from 'vitest';
import { renderMarkdownForEmail, reportEmailHtml } from './emailSender.js';

describe('market opinion email HTML', () => {
  it('renders headings, emphasis, lists and tables instead of exposing markdown markers', () => {
    const markdown = '### 关键结论\n\n1. **风险偏好下降**\n   - 验证条件\n\n| 指标 | 数值 |\n| --- | --- |\n| MSI | -82 |';
    const body = renderMarkdownForEmail(markdown);
    expect(body).toContain('<h3 style=');
    expect(body).toContain('<strong style=');
    expect(body).toContain('<ol style=');
    expect(body).toContain('<table style=');
    expect(body).not.toContain('###');
    expect(body).not.toContain('**');
  });

  it('blocks raw HTML, remote images and unsafe links', () => {
    const html = reportEmailHtml('测试', '<script>alert(1)</script> ![x](https://tracker.test/a.png) [x](javascript:alert(1))', '2026-07-19 13:14');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('javascript:');
  });
});
