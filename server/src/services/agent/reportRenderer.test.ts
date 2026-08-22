import { describe, expect, it } from 'vitest';
import { renderStaticAgentReport } from './reportRenderer.js';
import { validateAgentReport } from './reportValidator.js';

describe('renderStaticAgentReport', () => {
  it('escapes model HTML and produces a valid static report', () => {
    const report = renderStaticAgentReport('# 验收结论\n<script>steal()</script>\n结果正常。', 'classic-blue');
    expect(report.html).not.toContain('<script>');
    expect(report.html).toContain('&lt;script&gt;');
    expect(report.html).toContain('<meta name="viewport"');
    expect(report.html).not.toContain('安全静态版本');
    expect(report.html).not.toContain('STATIC REPORT');
    expect(validateAgentReport(report.html, Buffer.byteLength(report.html))).toEqual({ valid: true });
  });

  it('renders headings, emphasis, quotes and GFM tables as semantic HTML', () => {
    const report = renderStaticAgentReport([
      '# 下周研究结论',
      '> 核心结论：保持审慎。',
      '## 市场环境',
      '**风险**仍需验证。',
      '| 指数 | 涨跌 |',
      '| --- | ---: |',
      '| 中证2000 | -0.63% |',
    ].join('\n'), 'dashboard');
    expect(report.title).toBe('研究报告：下周研究结论');
    expect(report.html).toContain('data-style="dashboard"');
    expect(report.html).toContain('<blockquote>');
    expect(report.html).toContain('<h2>市场环境</h2>');
    expect(report.html).toContain('<strong>风险</strong>');
    expect(report.html).toContain('<table>');
    expect(report.html).not.toContain('# 下周研究结论');
    expect(validateAgentReport(report.html, Buffer.byteLength(report.html))).toEqual({ valid: true });
  });

  it('removes external navigation while preserving readable labels', () => {
    const report = renderStaticAgentReport('# 安全报告\n[来源](https://example.com) ![图表](https://example.com/chart.png)');
    expect(report.html).toContain('来源');
    expect(report.html).toContain('图表');
    expect(report.html).not.toContain('https://example.com');
    expect(report.html).not.toContain('<a ');
    expect(report.html).not.toContain('<img ');
  });

  it('falls back safely when an unknown style reaches the renderer', () => {
    const report = renderStaticAgentReport('# 安全报告', '" onload="steal' as never);
    expect(report.html).toContain('data-style="classic-blue"');
    expect(report.html).not.toContain('onload=');
  });
});
