import { describe, expect, it } from 'vitest';
import { renderStaticAgentReport } from './reportRenderer.js';
import { validateAgentReport } from './reportValidator.js';

describe('renderStaticAgentReport', () => {
  it('escapes model HTML and produces a valid static report', () => {
    const report = renderStaticAgentReport('# 验收结论\n<script>steal()</script>\n结果正常。');
    expect(report.html).not.toContain('<script>');
    expect(report.html).toContain('&lt;script&gt;');
    expect(validateAgentReport(report.html, Buffer.byteLength(report.html))).toEqual({ valid: true });
  });
});
