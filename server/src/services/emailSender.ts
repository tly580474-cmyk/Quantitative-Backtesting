import nodemailer, { type Transporter } from 'nodemailer';
import { marked } from 'marked';

export interface EmailSenderConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  from: string;
  to: string[];
}

export interface EmailMessage {
  subject: string;
  text: string;
  html: string;
}

export interface EmailDeliveryResult {
  messageId: string;
  accepted: string[];
  rejected: string[];
  response?: string;
}

export class EmailSender {
  private transporter: Transporter;

  constructor(private config: EmailSenderConfig) {
    this.transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: { user: config.user, pass: config.password },
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 30_000,
    });
  }

  isConfigured(): boolean {
    return Boolean(this.config.host && this.config.user && this.config.password && this.config.to.length);
  }

  async verify(): Promise<void> {
    if (!this.isConfigured()) throw new Error('SMTP 邮件配置不完整');
    await this.transporter.verify();
  }

  async send(message: EmailMessage): Promise<EmailDeliveryResult> {
    if (!this.isConfigured()) throw new Error('SMTP 邮件配置不完整');
    const result = await this.transporter.sendMail({
      from: this.config.from,
      to: this.config.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
    return {
      messageId: result.messageId,
      accepted: (result.accepted ?? []).map(String),
      rejected: (result.rejected ?? []).map(String),
      response: typeof result.response === 'string' ? result.response : undefined,
    };
  }
}

export function reportEmailHtml(title: string, markdown: string, generatedAt: string): string {
  const reportBody = renderMarkdownForEmail(markdown);
  const dataTimestamp = formatDataTimestamp(generatedAt);
  const summaryChips = extractSummaryChips(markdown);
  const { titleLead, titleHighlight, reportKindLabel } = parseReportTitle(title);
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>
  /* 自适应策略：阶梯式三档
     ① 默认（≥ 700px）：桌面端 左右分栏 + 三卡片并排（QQ 邮箱阅读器、iPad 竖屏、小平板）
     ② 480-700px：中等屏 标题缩小、左右分栏保留
     ③ < 480px：极窄屏（iPhone SE/12/13/14 全系列）切到上下结构 + 卡片堆叠
     断点不宜过高——QQ 邮箱/163 邮箱 web 阅读器视图渲染宽度常见 600-800px。 */
  @media only screen and (max-width: 700px) {
    .email-banner-title { font-size: 17px !important; line-height: 1.4 !important; }
    .email-banner-pill { font-size: 10px !important; padding: 3px 10px !important; }
    .email-banner-meta { font-size: 11px !important; }
    .email-wrap { padding: 22px 10px 28px !important; }
    .email-content { padding: 20px 22px 24px !important; }
  }
  @media only screen and (max-width: 480px) {
    .email-wrap { padding: 14px 6px 22px !important; }
    .email-banner-text { padding: 24px 24px 22px !important; }
    .email-banner-title { font-size: 18px !important; line-height: 1.45 !important; }
    .email-banner-meta { font-size: 11px !important; margin-top: 10px !important; }
    .email-banner-pill { font-size: 10px !important; padding: 3px 10px !important; }
    .email-chips-cell { display: block !important; width: 100% !important; padding: 6px 0 !important; }
    .email-chips-spacer { display: none !important; }
    .email-chips-cell-inner { padding: 12px 14px !important; }
    .email-content { padding: 18px 18px 22px !important; font-size: 14px !important; line-height: 1.7 !important; }
    .email-footer { font-size: 11px !important; padding: 12px 4px 0 !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:#eef2f7;color:#1a2233;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#eef2f7">
  <tr>
    <td align="center" class="email-wrap" style="padding:28px 14px 36px">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:780px">
        <tr>
          <td class="email-card" style="background:linear-gradient(135deg,#e9f1ff 0%,#f4f8ff 50%,#ffffff 100%);border-radius:14px;padding:0;border:1px solid #dbe3ef;position:relative;overflow:hidden">
            ${bannerDecor()}
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="position:relative">
              <tr>
                <td class="email-banner email-banner-text" style="padding:32px 36px 28px;vertical-align:middle;width:100%">
                  <div style="margin-bottom:14px">
                    <span class="email-banner-pill" style="display:inline-flex;align-items:center;gap:6px;padding:5px 14px;border-radius:999px;background:linear-gradient(135deg,#1f6ce0,#0e4ab0);color:#ffffff;font-size:11px;font-weight:600;letter-spacing:.4px;box-shadow:0 4px 12px rgba(31,108,224,0.32)">
                      <span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#ffffff;box-shadow:0 0 0 3px rgba(255,255,255,0.45)"></span>📊 市场观点智能体${reportKindLabel ? ` · ${escapeHtml(reportKindLabel)}` : ''}
                    </span>
                  </div>
                  <h1 class="email-banner-title" style="margin:6px 0 0;font-size:22px;line-height:1.45;font-weight:600;letter-spacing:.3px">
                    <span style="color:#0e2a5e">${escapeHtml(titleLead)}</span>${titleHighlight ? `<span style="color:#1f6ce0">${escapeHtml(titleHighlight)}</span>` : ''}
                  </h1>
                  <div class="email-banner-meta" style="margin-top:16px;color:#5b6a85;font-size:12px;line-height:1.5">
                    <span style="display:inline-block;width:14px;height:14px;line-height:14px;text-align:center;border:1px solid #b0c2dc;border-radius:50%;font-size:10px;margin-right:6px;vertical-align:middle;color:#1f6ce0">⏱</span>数据截至 ${escapeHtml(dataTimestamp)}
                  </div>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        ${summaryChips ? `<tr><td style="height:14px;line-height:14px;font-size:0;line-height:0">&nbsp;</td></tr>
        <tr>
          <td class="email-chips-row">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
              <tr>
                ${summaryChips}
              </tr>
            </table>
          </td>
        </tr>` : ''}
        <tr><td style="height:18px;line-height:18px;font-size:0">&nbsp;</td></tr>
        <tr>
          <td class="email-content" style="background:#ffffff;padding:24px 30px 28px;border:1px solid #dbe3ef;border-radius:14px;font-size:15px;line-height:1.78;color:#24364d;word-break:break-word">
            ${reportBody}
          </td>
        </tr>
        <tr>
          <td class="email-footer" style="padding:14px 6px 0;text-align:center;color:#8593a9;font-size:12px;line-height:1.6">
            生成时间：${escapeHtml(generatedAt)} · 内容用于研究与信息整理，不构成投资建议。
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body></html>`;
}

/**
 * 解析报告标题，识别前缀、日期和报告类型三段，返回分段文本。
 * 输入示例：
 *   "【模拟推送】【市场观点智能体】2026-07-31 财经午报"
 *     → { titleLead: "【模拟推送】【市场观点智能体】", titleHighlight: "2026-07-31 财经午报", reportKindLabel: "财经午报" }
 *   "【市场观点智能体】2026-07-31 盘后总结"
 *     → { titleLead: "【市场观点智能体】", titleHighlight: "2026-07-31 盘后总结", reportKindLabel: "盘后总结" }
 * 无法识别时整体作为 lead，不高亮。
 */
function parseReportTitle(title: string): { titleLead: string; titleHighlight: string; reportKindLabel: string } {
  const kindLabels: Record<string, string> = {
    morning: '消息早报', midday: '财经午报', close: '盘后总结',
    '消息早报': '消息早报', '财经午报': '财经午报', '盘后总结': '盘后总结',
    '早报': '消息早报', '午报': '财经午报', '盘后': '盘后总结',
  };
  const datePattern = /(\d{4}[-年]\d{1,2}[-月]\d{1,2}日?)/;
  const dateMatch = title.match(datePattern);
  if (!dateMatch || dateMatch.index === undefined) {
    return { titleLead: title, titleHighlight: '', reportKindLabel: '' };
  }
  const dateIdx = dateMatch.index;
  const datePart = dateMatch[1];
  const afterDate = title.slice(dateIdx + datePart.length).trim();
  let kindLabel = '';
  let highlightRest = afterDate;
  for (const key of Object.keys(kindLabels)) {
    if (afterDate === key || afterDate.startsWith(key + ' ') || afterDate.startsWith(key)) {
      kindLabel = kindLabels[key]!;
      highlightRest = afterDate;
      break;
    }
  }
  return {
    titleLead: title.slice(0, dateIdx).trim(),
    titleHighlight: `${datePart}${highlightRest ? ' ' + highlightRest : ''}`.trim(),
    reportKindLabel: kindLabel,
  };
}

function bannerDecor(): string {
  // 右上角点阵装饰 + 浅蓝曲线背景
  return `<div aria-hidden="true" style="position:absolute;top:0;right:0;width:180px;height:120px;background-image:radial-gradient(circle at 8px 8px,rgba(31,108,224,0.18) 1.6px,transparent 1.8px);background-size:18px 18px;opacity:.7;pointer-events:none"></div>
<div aria-hidden="true" style="position:absolute;left:-40px;bottom:-40px;width:200px;height:200px;border-radius:50%;background:radial-gradient(circle,rgba(31,108,224,0.08),transparent 70%);pointer-events:none"></div>`;
}

function formatDataTimestamp(generatedAt: string): string {
  const date = new Date(generatedAt);
  if (Number.isNaN(date.getTime())) return generatedAt;
  const datePart = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(date);
  const timePart = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false })
    .format(date);
  return `${datePart} ${timePart}`;
}

/**
 * 从 Markdown 报告中提取最多 3 个关键结论作为亮点卡片。
 * 解析策略：抓取"一、关键结论"或"关键结论"标题下的有序列表第一项，
 * 取冒号前的中文短句作为标题，冒号后第一句作为描述。
 */
function extractSummaryChips(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const headingIdx = lines.findIndex((line) => /关键结论|核心观点|关键观点|可执行观察结论|观察结论|重要结论|主要观点/.test(line));
  if (headingIdx < 0) return '';
  const chips: { title: string; desc: string }[] = [];
  for (let i = headingIdx + 1; i < lines.length && chips.length < 3; i++) {
    const raw = lines[i].trim();
    if (!raw) continue;
    if (/^#{1,6}\s/.test(raw)) break;
    const match = raw.match(/^\d+[.、．)]\s*(.+)$/) || raw.match(/^[-*+]\s*(.+)$/);
    if (!match) continue;
    const body = match[1]
      .replace(/^[*_`]+|[*_`]+$/g, '')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*+/g, '')
      .trim();
    const colonMatch = body.match(/^([^：:]{2,16})[：:]\s*(.{4,80})/);
    if (colonMatch) {
      chips.push({ title: colonMatch[1].trim().replace(/[*_`]/g, ''), desc: colonMatch[2].trim() });
    } else {
      const short = body.replace(/。.*$/, '').replace(/[*_`]/g, '').trim();
      if (short && short.length >= 4) chips.push({ title: short.slice(0, 12), desc: short });
    }
  }
  if (!chips.length) return '';
  return chips.map((chip, idx) => {
    const icon = ['📈', '🔥', '🕐'][idx] ?? '•';
    return `<td class="email-chips-cell" align="left" valign="top" style="padding:18px 0;width:33.33%">
      <div class="email-chips-cell-inner" style="background:#ffffff;border:1px solid #e3eaf5;border-radius:10px;padding:14px 16px;box-shadow:0 4px 14px rgba(20,55,121,0.06)">
        <div style="font-size:18px;line-height:1;margin-bottom:8px">${icon}</div>
        <div style="font-size:14px;font-weight:600;color:#0e2a5e;line-height:1.4;margin-bottom:4px">${escapeHtml(chip.title)}</div>
        <div style="font-size:12px;color:#5b6a85;line-height:1.55">${escapeHtml(chip.desc)}</div>
      </div>
    </td>${idx < chips.length - 1 ? '<td class="email-chips-spacer" style="width:14px"></td>' : ''}`;
  }).join('');
}


export function renderMarkdownForEmail(markdown: string): string {
  const withoutRemoteImages = markdown.replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1');
  const escapedInput = withoutRemoteImages.replace(/[&<>]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char]!);
  let html = marked.parse(escapedInput, { gfm: true, breaks: true, async: false }) as string;
  html = html.replace(/href="([^"]*)"/g, (_match, href: string) => {
    const safe = /^(https?:|mailto:)/i.test(href) ? href : '#';
    return `href="${escapeHtml(safe)}"`;
  });
  const tags: Array<[RegExp, string]> = [
    [/<h1>/g, '<h1 style="margin:0 0 18px;font-size:24px;line-height:1.4;color:#10233f">'],
    [/<h2>/g, '<h2 style="margin:28px 0 12px;padding-bottom:8px;border-bottom:2px solid #e6edf5;font-size:21px;line-height:1.45;color:#10233f">'],
    [/<h3>/g, '<h3 style="margin:24px 0 10px;font-size:18px;line-height:1.5;color:#16345d">'],
    [/<h4>/g, '<h4 style="margin:20px 0 8px;font-size:16px;line-height:1.5;color:#24476f">'],
    [/<p>/g, '<p style="margin:0 0 14px;line-height:1.75;color:#24364d">'],
    [/<ol>/g, '<ol style="margin:8px 0 18px;padding-left:24px;color:#24364d">'],
    [/<ul>/g, '<ul style="margin:8px 0 18px;padding-left:22px;color:#24364d">'],
    [/<li>/g, '<li style="margin:0 0 9px;line-height:1.7">'],
    [/<strong>/g, '<strong style="color:#10233f;font-weight:700">'],
    [/<blockquote>/g, '<blockquote style="margin:16px 0;padding:12px 16px;border-left:4px solid #5279a8;background:#f4f7fb;color:#40546e">'],
    [/<code>/g, '<code style="padding:2px 5px;border-radius:4px;background:#eef2f7;color:#9b2943;font-family:Consolas,monospace;font-size:13px">'],
    [/<pre>/g, '<pre style="margin:14px 0;padding:14px;overflow:auto;border-radius:8px;background:#101827;color:#eef4ff;white-space:pre-wrap">'],
    [/<hr>/g, '<hr style="margin:24px 0;border:0;border-top:1px solid #dce4ee">'],
    [/<a /g, '<a style="color:#175ea8;text-decoration:underline" '],
    [/<table>/g, '<div style="margin:16px 0;overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:13px">'],
    [/<\/table>/g, '</table></div>'],
    [/<th>/g, '<th style="padding:9px;border:1px solid #d7e0eb;background:#edf3f9;text-align:left;color:#10233f">'],
    [/<td>/g, '<td style="padding:9px;border:1px solid #d7e0eb;vertical-align:top;color:#24364d">'],
  ];
  for (const [pattern, replacement] of tags) html = html.replace(pattern, replacement);
  return html;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]!);
}
