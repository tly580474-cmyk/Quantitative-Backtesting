import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it, expect } from 'vitest';
import { collectReportAssets, taskArtifactDirectory } from './reportAssets.js';
import { renderStaticAgentReport } from './reportRenderer.js';
import { validateAgentReport } from './reportValidator.js';

it('embeds only current task raster assets, counts them and rejects traversal and SVG', async () => {
  const root = await mkdtemp(join(tmpdir(), 'report-assets-'));
  try {
    const task = taskArtifactDirectory(root, 'run-1');
    await mkdir(task, { recursive: true });
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZkAAAAASUVORK5CYII=', 'base64');
    await writeFile(join(task, 'chart.png'), png);
    await writeFile(join(root, 'private.png'), png);
    await writeFile(join(task, 'bad.svg'), '<svg onload="alert(1)"/>');
    const content = '# 图表\n![中文图表](tmp_output/agent-runs/run-1/chart.png)';
    const assets = await collectReportAssets(content, root, 'run-1');
    const report = renderStaticAgentReport(content, 'minimal-white', assets);
    expect(report.chartsCount).toBe(1);
    expect(report.html).toContain('data:image/png;base64,');
    expect(validateAgentReport(report.html, Buffer.byteLength(report.html)).valid).toBe(true);
    await expect(collectReportAssets('![秘密](private.png)', root, 'run-1')).rejects.toThrow('当前任务');
    await expect(collectReportAssets('![图](tmp_output/agent-runs/run-1/bad.svg)', root, 'run-1')).rejects.toThrow('PNG/JPEG');
    expect((await collectReportAssets('![图](https://evil.test/x.png)', root, 'run-1')).size).toBe(0);
    if (process.platform !== 'win32') {
      await symlink(join(root, 'private.png'), join(task, 'escape.png'));
      await expect(collectReportAssets('![图](tmp_output/agent-runs/run-1/escape.png)', root, 'run-1')).rejects.toThrow('当前任务');
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
