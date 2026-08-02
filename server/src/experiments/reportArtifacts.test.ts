import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildReportHtml, isArtifactPathInsideRoot, renderReportArtifact } from './reportArtifacts.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('experiment report artifact renderer', () => {
  it('renders a self-contained printable HTML artifact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'report-html-'));
    roots.push(root);
    const path = await renderReportArtifact('# 报告\n\n| 指标 | 数值 |\n|---|---:|\n| 收益 | 12% |', 'abc', 'html', {
      artifactRoot: root,
      timeoutMs: 5000,
    });
    const html = await readFile(path, 'utf8');
    expect(html).toContain('<html lang="zh-CN">');
    expect(html).toContain('<table>');
    expect(html).toContain('实验报告');
  });

  it('renders a real PDF through the configured Chromium executable when available', async () => {
    const chrome = process.platform === 'win32'
      ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
      : process.env.EXPERIMENT_REPORT_CHROMIUM_EXECUTABLE;
    if (!chrome) return;
    const root = await mkdtemp(join(tmpdir(), 'report-pdf-'));
    roots.push(root);
    const path = await renderReportArtifact('# PDF 验收\n\n独立 Worker 制品。', 'pdf-test', 'pdf', {
      artifactRoot: root,
      chromiumExecutable: chrome,
      timeoutMs: 30_000,
    });
    expect((await stat(path)).size).toBeGreaterThan(1000);
    expect((await readFile(path)).subarray(0, 4).toString()).toBe('%PDF');
  }, 35_000);

  it('rejects paths outside the managed artifact root', async () => {
    const html = await buildReportHtml('hello');
    expect(html).toContain('<p>hello</p>');
    expect(isArtifactPathInsideRoot('C:/outside/report.pdf', 'C:/managed')).toBe(false);
    expect(isArtifactPathInsideRoot('C:/managed/report.pdf', 'C:/managed')).toBe(true);
  });
});
