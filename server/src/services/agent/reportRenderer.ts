import { Marked } from 'marked';
import { sanitizePublicContent } from './eventProtocol.js';
import type { TemplateStyle } from './promptBuilder.js';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const staticRenderer = {
  html({ text }: { text: string }): string {
    return `<p class="literal-html">${escapeHtml(text)}</p>`;
  },

  link(this: { parser: { parseInline(tokens: unknown[]): string } }, { tokens }: { tokens: unknown[] }): string {
    return this.parser.parseInline(tokens);
  },

  image({ text }: { text: string }): string {
    return `<span class="image-placeholder">${escapeHtml(text || '图片已省略')}</span>`;
  },
};

const markdown = new Marked({
  async: false,
  gfm: true,
  breaks: false,
  renderer: staticRenderer,
});

function reportTitle(content: string): string {
  const lines = content.split('\n');
  const heading = lines.map(line => line.match(/^#\s+(.+)$/)?.[1]?.trim()).find(Boolean);
  const fallback = lines.map(line => line.replace(/^#+\s*/, '').trim()).find(Boolean) ?? '研究报告';
  const value = heading ?? fallback;
  return (value.startsWith('研究报告') ? value : `研究报告：${value}`).slice(0, 80);
}

function withoutLeadingTitle(content: string): string {
  const lines = content.split('\n');
  const firstContent = lines.findIndex(line => line.trim().length > 0);
  if (firstContent >= 0 && /^#\s+/.test(lines[firstContent])) lines.splice(firstContent, 1);
  return lines.join('\n').trim();
}

function plainSummary(content: string): string {
  return content
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_`>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

export function renderStaticAgentReport(
  content: string,
  templateStyle: TemplateStyle = 'classic-blue',
): { html: string; title: string; summary: string } {
  const resolvedStyle: TemplateStyle = (
    ['classic-blue', 'dark-pro', 'minimal-white', 'dashboard'] as const
  ).includes(templateStyle) ? templateStyle : 'classic-blue';
  const safeContent = sanitizePublicContent(content, '本轮未生成报告正文');
  const title = reportTitle(safeContent);
  const summary = plainSummary(safeContent);
  const summaryComment = escapeHtml(summary.replace(/--/g, '—'));
  const article = String(markdown.parse(withoutLeadingTitle(safeContent), { async: false }));
  const generatedAt = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date());

  const html = `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title><style>
:root{color-scheme:light;--bg:#f3f6fb;--surface:#fff;--surface-soft:#f8fafc;--ink:#172033;--muted:#526079;--line:#dce4ef;--accent:#155eef;--accent-2:#3b82f6;--accent-soft:#eaf2ff;--shadow:0 14px 42px rgba(19,37,69,.09)}
*{box-sizing:border-box}html{background:var(--bg)}body{margin:0;background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;font-size:16px;line-height:1.75;text-rendering:optimizeLegibility}.report{width:min(1120px,calc(100% - 40px));margin:0 auto;padding:44px 0 72px}.hero{position:relative;overflow:hidden;padding:34px 40px;border:1px solid color-mix(in srgb,var(--accent) 24%,transparent);border-radius:20px;background:linear-gradient(128deg,#0b2555 0%,var(--accent) 58%,var(--accent-2) 100%);color:#fff;box-shadow:var(--shadow)}.hero:after{content:"";position:absolute;right:-90px;top:-130px;width:330px;height:330px;border:70px solid rgba(255,255,255,.075);border-radius:50%}.eyebrow{position:relative;z-index:1;margin:0 0 10px;font-size:12px;font-weight:700;letter-spacing:.16em;opacity:.78}.hero h1{position:relative;z-index:1;max-width:850px;margin:0;font-size:clamp(26px,4vw,40px);line-height:1.28;letter-spacing:-.025em}.meta{position:relative;z-index:1;margin-top:16px;font-size:13px;opacity:.76}.paper{margin-top:22px;padding:42px 48px;border:1px solid var(--line);border-radius:20px;background:var(--surface);box-shadow:var(--shadow)}.content{max-width:860px;margin:0 auto}.content>p:first-child{margin-top:0}.content h2{margin:2.15em 0 .75em;padding-bottom:.42em;border-bottom:1px solid var(--line);font-size:1.55rem;line-height:1.35;letter-spacing:-.015em}.content h2:before{content:"";display:inline-block;width:4px;height:.9em;margin-right:10px;border-radius:3px;background:var(--accent);vertical-align:-.02em}.content h3{margin:1.7em 0 .55em;font-size:1.18rem;line-height:1.4}.content p{margin:.8em 0}.content strong{color:#0b1f44;font-weight:700}.content ul,.content ol{padding-left:1.35em}.content li{margin:.34em 0}.content blockquote{margin:1.3em 0;padding:16px 20px;border:1px solid #cfe0ff;border-left:4px solid var(--accent);border-radius:0 12px 12px 0;background:var(--accent-soft);color:#173765}.content blockquote p{margin:.25em 0}.content table{display:block;width:100%;margin:1.35em 0;border-spacing:0;border-collapse:separate;border:1px solid var(--line);border-radius:12px;overflow-x:auto;white-space:nowrap}.content thead{background:var(--surface-soft)}.content th,.content td{padding:11px 14px;border-right:1px solid var(--line);border-bottom:1px solid var(--line);text-align:left;vertical-align:top}.content th{color:#34425a;font-size:.86rem;font-weight:700;letter-spacing:.02em}.content tr:last-child td{border-bottom:0}.content th:last-child,.content td:last-child{border-right:0}.content code{padding:.16em .4em;border:1px solid var(--line);border-radius:5px;background:var(--surface-soft);font-family:"SFMono-Regular",Consolas,monospace;font-size:.88em}.content pre{overflow:auto;padding:18px;border:1px solid var(--line);border-radius:10px;background:#101827;color:#e7edf7}.content pre code{padding:0;border:0;background:transparent;color:inherit}.content hr{height:1px;margin:2em 0;border:0;background:var(--line)}.literal-html,.image-placeholder{color:var(--muted);font-family:monospace;overflow-wrap:anywhere}.footer{display:flex;justify-content:space-between;gap:16px;margin-top:18px;padding:0 4px;color:var(--muted);font-size:12px}
[data-style="minimal-white"]{--bg:#f8f8f6;--accent:#1f2937;--accent-2:#4b5563;--accent-soft:#f3f4f6;--shadow:0 8px 30px rgba(0,0,0,.05)}[data-style="minimal-white"] .hero{border-color:#303742;background:#202630}[data-style="dashboard"]{--bg:#edf2f8;--surface-soft:#edf4ff;--accent:#0b6bcb;--accent-2:#16a3a3}[data-style="dashboard"] .paper{padding:32px 36px}[data-style="dashboard"] .content{max-width:none}[data-style="dark-pro"]{color-scheme:dark;--bg:#07101f;--surface:#0d192b;--surface-soft:#13223a;--ink:#edf4ff;--muted:#aebbd0;--line:#293a55;--accent:#5ea2ff;--accent-2:#795cf5;--accent-soft:#142b4c;--shadow:0 18px 48px rgba(0,0,0,.3)}[data-style="dark-pro"] .hero{background:linear-gradient(128deg,#101c31,#174d8f 58%,#5b43b7)}[data-style="dark-pro"] .content strong{color:#fff}[data-style="dark-pro"] .content blockquote{border-color:#315782;background:#102a4a;color:#d9eaff}[data-style="dark-pro"] .content pre{background:#050b14}
@media(max-width:700px){body{font-size:16px}.report{width:min(100% - 24px,1120px);padding:18px 0 40px}.hero{padding:25px 22px;border-radius:15px}.paper,[data-style="dashboard"] .paper{padding:25px 20px;border-radius:15px}.content h2{font-size:1.34rem}.footer{display:block}.footer span{display:block;margin-top:3px}}
@media print{html,body{background:#fff}.report{width:100%;padding:0}.hero{border-radius:0;box-shadow:none;print-color-adjust:exact}.paper{margin-top:0;padding:30px 0;border:0;box-shadow:none}.content{max-width:none}.content table{white-space:normal}.footer{border-top:1px solid var(--line);padding-top:10px}h2,h3,blockquote,table{break-inside:avoid}}
</style></head><body data-style="${resolvedStyle}"><main class="report"><header class="hero"><p class="eyebrow">WANHANG RESEARCH</p><h1>${escapeHtml(title)}</h1></header><article class="paper"><div class="content">${article}</div></article><footer class="footer"><span>由万行智研生成</span><span>生成时间 ${escapeHtml(generatedAt)}</span></footer></main>
<!-- REPORT_SUMMARY: ${summaryComment} --></body></html>`;
  return { html, title, summary };
}
