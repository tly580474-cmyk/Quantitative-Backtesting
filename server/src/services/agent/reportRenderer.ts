import { sanitizePublicContent } from './eventProtocol.js';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderStaticAgentReport(content: string): { html: string; title: string; summary: string } {
  const safeContent = sanitizePublicContent(content, '本轮未生成报告正文');
  const firstLine = safeContent
    .split('\n')
    .map(line => line.replace(/^#+\s*/, '').trim())
    .find(Boolean) ?? '研究报告';
  const title = (firstLine.startsWith('研究报告') ? firstLine : `研究报告：${firstLine}`).slice(0, 120);
  const summary = safeContent.replace(/\s+/g, ' ').slice(0, 240);
  const html = `<!doctype html>
<html lang="zh-CN"><head>
<title>${escapeHtml(title)}</title><style>
:root{color-scheme:light}*{box-sizing:border-box}body{margin:0;background:#f6f8fb;color:#172033;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;line-height:1.75}.report{max-width:960px;margin:0 auto;padding:48px 24px 72px}.hero{padding:28px 32px;border-radius:18px;background:linear-gradient(135deg,#1769e0,#5a8ff0);color:#fff;box-shadow:0 16px 40px rgba(23,105,224,.2)}h1{margin:0;font-size:28px}.meta{margin-top:8px;opacity:.82;font-size:13px}.card{margin-top:22px;padding:28px 32px;border:1px solid #e2e8f2;border-radius:16px;background:#fff;box-shadow:0 8px 28px rgba(22,34,58,.06)}pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;color:inherit}@media(max-width:640px){.report{padding:20px 12px 48px}.hero,.card{padding:20px;border-radius:13px}h1{font-size:22px}}
</style></head><body><main class="report"><header class="hero"><h1>${escapeHtml(title)}</h1><div class="meta">由万行智研生成 · 静态安全版本</div></header><article class="card"><pre>${escapeHtml(safeContent)}</pre></article></main>
<!-- REPORT_SUMMARY: ${escapeHtml(summary)} --></body></html>`;
  return { html, title, summary };
}
