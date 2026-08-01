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

export interface EmailSendOptions {
  /** 最大尝试次数（含首次），默认 3。 */
  maxAttempts?: number;
  /** 重试退避基数（毫秒），按尝试次数线性递增，默认 2000。 */
  retryDelayMs?: number;
}

const DEFAULT_EMAIL_MAX_ATTEMPTS = 3;
const DEFAULT_EMAIL_RETRY_DELAY_MS = 2_000;

// 标准金融蓝
const BRAND_BLUE = '#1a73e8';
const BRAND_BLUE_DARK = '#1557b0';
const BRAND_BLUE_LIGHT = '#e8f0fe';
const BRAND_BLUE_LIGHTER = '#f4f8ff';

/**
 * 判定一个 SMTP 投递错误是否值得重试。仅在网络超时、连接重置、
 * DNS 抖动等瞬时故障，以及 SMTP 4xx 临时性响应时返回 true；
 * 鉴权失败、5xx 永久性错误等不重试，避免无意义消耗宽限窗口。
 */
export function isTransientEmailError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const err = error as { code?: string; responseCode?: number; message?: string };
  const transientNetworkCodes = new Set([
    'ETIMEDOUT', 'ESOCKETTIMEOUT', 'ECONNRESET', 'ECONNREFUSED',
    'EPIPE', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH',
  ]);
  if (err.code && transientNetworkCodes.has(err.code)) return true;
  if (typeof err.responseCode === 'number' && err.responseCode >= 400 && err.responseCode < 500) return true;
  if (typeof err.message === 'string' && /timeout|timed out/i.test(err.message)) return true;
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, ms));
    timer.unref?.();
  });
}

/**
 * 对单次投递操作执行带线性退避的重试。仅在瞬时错误时重试；
 * 永久性错误或达到最大尝试次数后立即抛出。抽离为独立函数便于单测。
 */
export async function sendEmailWithRetry(
  sendOnce: () => Promise<EmailDeliveryResult>,
  options: EmailSendOptions = {},
): Promise<EmailDeliveryResult> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_EMAIL_MAX_ATTEMPTS);
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? DEFAULT_EMAIL_RETRY_DELAY_MS);
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await sendOnce();
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !isTransientEmailError(error)) throw error;
      await sleep(retryDelayMs * attempt);
    }
  }
  throw lastError;
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

  async send(message: EmailMessage, options: EmailSendOptions = {}): Promise<EmailDeliveryResult> {
    if (!this.isConfigured()) throw new Error('SMTP 邮件配置不完整');
    return sendEmailWithRetry(async () => {
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
    }, options);
  }
}

export interface EmailHighlightCard {
  icon: 'chart' | 'medal' | 'clock' | 'bull' | 'bear' | 'alert';
  title: string;
  subtitle: string;
}

export interface EmailHeaderData {
  /** 报告类型标签，如"财经午报" */
  kindLabel: string;
  /** 日期字符串，如"2026-07-31" */
  dateStr: string;
  /** 数据截至时间文案，如"数据截至 2026-07-31 14:30" */
  dataCutoffText: string;
  /** 亮点卡片数据，最多3条 */
  highlights: EmailHighlightCard[];
}

// 金融主题装饰图 - K线上升趋势SVG（base64内嵌，清晰小巧）
const HEADER_DECO_SVG_BASE64 = 'PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxNjAgMTIwIiBmaWxsPSJub25lIj48ZGVmcz48bGluZWFyR3JhZGllbnQgaWQ9ImciIHgxPSIwIiB5MT0iMCIgeDI9IjAiIHkyPSIxIj48c3RvcCBvZmZzZXQ9IjAlIiBzdG9wLWNvbG9yPSIjMWE3M2U4IiBzdG9wLW9wYWNpdHk9IjAuMTIiLz48c3RvcCBvZmZzZXQ9IjEwMCUiIHN0b3AtY29sb3I9IiMxYTczZTgiIHN0b3Atb3BhY2l0eT0iMC4wMyIvPjwvbGluZWFyR3JhZGllbnQ+PC9kZWZzPjxyZWN0IHdpZHRoPSIxNjAiIGhlaWdodD0iMTIwIiBmaWxsPSJ1cmwoI2cpIiByeD0iMTQiLz48cGF0aCBkPSJNMjAgOTUgTDM1IDgwTDUwIDg1TDY1IDY1TDgwIDc1TDk1IDU1TDExMCA2MEwxMjUgNDVMMTQwIDU1IiBzdHJva2U9IiMxYTczZTgiIHN0cm9rZS13aWR0aD0iMyIgZmlsbD0ibm9uZSIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIi8+PHJlY3QgeD0iMzAiIHk9Ijc1IiB3aWR0aD0iNSIgaGVpZ2h0PSIyMCIgcng9IjIuNSIgZmlsbD0iIzIyYzU3MiIvPjxyZWN0IHg9IjQ1IiB5PSI4MCIgd2lkdGg9IjUiIGhlaWdodD0iMTUiIHJ4PSIyLjUiIGZpbGw9IiNkMzJmMmZmIi8+PHJlY3QgeD0iNjAiIHk9IjYwIiB3aWR0aD0iNSIgaGVpZ2h0PSIyNSIgcng9IjIuNSIgZmlsbD0iIzIyYzU3MiIvPjxyZWN0IHg9Ijc1IiB5PSI3MCIgd2lkdGg9IjUiIGhlaWdodD0iMTUiIHJ4PSIyLjUiIGZpbGw9IiMyMmM1NzIiLz48cmVjdCB4PSI5MCIgeT0iNTAiIHdpZHRoPSI1IiBoZWlnaHQ9IjMwIiByeD0iMi41IiBmaWxsPSIjMjJjNTcyIi8+PHJlY3QgeD0iMTA1IiB5PSI1NSIgd2lkdGg9IjUiIGhlaWdodD0iMjAiIHJ4PSIyLjUiIGZpbGw9IiMyMmM1NzIiLz48cmVjdCB4PSIxMjAiIHk9IjQwIiB3aWR0aD0iNSIgaGVpZ2h0PSIyNSIgcng9IjIuNSIgZmlsbD0iIzIyYzU3MiIvPjxjaXJjbGUgY3g9IjE0MCIgY3k9IjU1IiByPSI2IiBmaWxsPSIjMWE3M2U4IiBmaWxsLW9wYWNpdHk9IjAuMTUiLz48Y2lyY2xlIGN4PSIxNDAiIGN5PSI1NSIgcj0iMyIgZmlsbD0iIzFhNzNlOCIvPjwvc3ZnPg==';

const ICON_SVGS: Record<EmailHighlightCard['icon'], string> = {
  chart: `data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="' + BRAND_BLUE + '"><path d="M3 13c.55 0 1 .45 1 1v4c0 .55-.45 1-1 1s-1-.45-1-1v-4c0-.55.45-1 1-1zm4-4c.55 0 1 .45 1 1v8c0 .55-.45 1-1 1s-1-.45-1-1v-8c0-.55.45-1 1-1zm4-4c.55 0 1 .45 1 1v12c0 .55-.45 1-1 1s-1-.45-1-1V6c0-.55.45-1 1-1zm4-4c.55 0 1 .45 1 1v16c0 .55-.45 1-1 1s-1-.45-1-1V2c0-.55.45-1 1-1z"/></svg>')}`,
  medal: `data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="' + BRAND_BLUE + '"><path d="M12 2L9 5l3 3 3-3zm0 0l3 3-3 3-3-3zM5 9l14 1-7 10-5-5 7-2z"/></svg>')}`,
  clock: `data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="' + BRAND_BLUE + '"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18h-2v-6H7v-2h3V7h2v6h3v2h-3v5z"/></svg>')}`,
  bull: `data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="' + BRAND_BLUE + '"><path d="M3 17v-2l3-3 3 3 4-5 4 4 2-3v4l-4 3-4-5-4 5-4-4-3 3z"/></svg>')}`,
  bear: `data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#d32f2f"><path d="M3 7v2l3 3 3-3 4 5 4-4 2 3v-4l-4-3-4 5-4-5-4 4-3-3z"/></svg>')}`,
  alert: `data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#f59e0b"><path d="M1 21h22L12 2 1 21zm11-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>')}`,
};

function getHighlightIcon(icon: EmailHighlightCard['icon']): string {
  return ICON_SVGS[icon] || ICON_SVGS.chart;
}

function renderHighlightCard(card: EmailHighlightCard): string {
  const iconSrc = getHighlightIcon(card.icon);
  return `<td class="highlight-card-cell" width="33%" valign="top" style="padding:0 4px;box-sizing:border-box;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background:#fff;border-radius:14px;border:1px solid #e0e9f5;box-shadow:0 6px 18px rgba(26,115,232,0.10),0 2px 6px rgba(26,115,232,0.06);">
      <tr><td style="padding:14px 10px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
          <td width="36" style="padding-right:8px;vertical-align:middle;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="width:34px;height:34px;background:linear-gradient(135deg,#e8f0fe 0%,#d2e3fc 100%);border-radius:10px;box-shadow:inset 0 1px 2px rgba(255,255,255,0.8);margin:0 auto;"><tr><td align="center" valign="middle" style="padding:0;">
              <img src="${iconSrc}" width="18" height="18" alt="" style="display:block;border:0;margin:0 auto;">
            </td></tr></table>
          </td>
          <td style="vertical-align:middle;">
            <div class="highlight-title" style="font-size:13px;font-weight:700;color:#0d1b2a;line-height:1.35;margin:0 0 2px;word-break:break-word;">${escapeHtml(card.title)}</div>
            <div class="highlight-subtitle" style="font-size:11px;color:#5f7390;line-height:1.4;margin:0;word-break:break-word;">${escapeHtml(card.subtitle)}</div>
          </td>
        </tr></table>
      </td></tr>
    </table>
  </td>`;
}

function splitTitleParts(subject: string): { prefix: string; bluePart: string } {
  const dateMatch = subject.match(/^(.*?)(\d{4}-\d{2}-\d{2}.*)$/);
  if (dateMatch) {
    return { prefix: dateMatch[1]!.trim(), bluePart: dateMatch[2]!.trim() };
  }
  return { prefix: subject, bluePart: '' };
}

// 响应式CSS - 手机端适配
const RESPONSIVE_STYLE = `
<style type="text/css">
  @media only screen and (max-width: 520px) {
    .header-deco { display: none !important; width: 0 !important; padding: 0 !important; font-size:0 !important; line-height:0 !important; max-height:0 !important; overflow:hidden !important; }
    .header-content { padding: 24px 20px 20px !important; }
    .email-title { font-size: 20px !important; }
    .cards-container { padding: 8px 12px 6px !important; }
    .highlight-card-cell {
      display: block !important;
      width: 100% !important;
      max-width: 100% !important;
      padding: 3px 0 !important;
      float: none !important;
      box-sizing: border-box !important;
    }
    .highlight-title { font-size: 15px !important; }
    .highlight-subtitle { font-size: 12px !important; }
    .content-body { padding: 24px 20px 20px !important; }
    .content-body div, .content-body p { font-size: 14px !important; line-height: 1.8 !important; }
  }
</style>
<!--[if mso]>
<style type="text/css">
  .highlight-card-cell { width: 33% !important; padding: 0 4px !important; }
</style>
<![endif]-->
`;

export function reportEmailHtml(
  title: string,
  markdown: string,
  generatedAt: string,
  headerData?: EmailHeaderData,
): string {
  const reportBody = renderMarkdownForEmail(markdown);
  const { prefix, bluePart } = splitTitleParts(title);
  const highlights = headerData?.highlights ?? [];
  const dataCutoffText = headerData?.dataCutoffText ?? '';
  const kindLabel = headerData?.kindLabel ?? '';
  const dateStr = headerData?.dateStr ?? '';

  const badgeLabel = kindLabel ? `市场观点智能体 · ${kindLabel}` : '市场观点智能体';

  const highlightCardsHtml = highlights.length > 0
    ? `<tr><td class="cards-container" style="background:linear-gradient(180deg,#e4eefc 0%,#edf3fc 50%,#f4f8ff 100%);padding:8px 16px 6px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;">
          <tr class="highlight-row">${highlights.map(renderHighlightCard).join('')}</tr>
        </table>
      </td></tr>`
    : '';

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>${RESPONSIVE_STYLE}</head>
<body style="margin:0;padding:0;background:linear-gradient(180deg,#e8eef7 0%,#f0f4fa 40%,#f4f7fb 100%);color:#1a2a41;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei','PingFang SC','Hiragino Sans GB',sans-serif;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:linear-gradient(180deg,#e8eef7 0%,#f0f4fa 40%,#f4f7fb 100%);">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:680px;width:100%;border-collapse:separate;">

<!-- Header with enhanced shadow and gradient -->
<tr><td style="background:linear-gradient(135deg,#e8f0fe 0%,#d2e3fc 60%,#c4dafc 100%);border-radius:20px 20px 0 0;overflow:hidden;box-shadow:0 12px 32px rgba(26,115,232,0.15),0 4px 12px rgba(26,115,232,0.08),inset 0 1px 0 rgba(255,255,255,0.6);position:relative;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
<tr>
<td class="header-content" style="padding:32px 28px 26px;vertical-align:top;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="background:linear-gradient(135deg,${BRAND_BLUE} 0%,${BRAND_BLUE_DARK} 100%);border-radius:24px;padding:8px 20px;box-shadow:0 4px 12px rgba(26,115,232,0.30),inset 0 1px 0 rgba(255,255,255,0.2);">
<span style="color:#fff;font-size:13px;font-weight:600;letter-spacing:.4px;white-space:nowrap;text-shadow:0 1px 2px rgba(0,0,0,0.1);">📊 ${escapeHtml(badgeLabel)}</span>
</td></tr></table>
<h1 class="email-title" style="margin:18px 0 12px;font-size:24px;line-height:1.4;font-weight:700;color:#0d1b2a;letter-spacing:-0.2px;">
${escapeHtml(prefix)}<br><span style="color:${BRAND_BLUE};">${escapeHtml(bluePart || dateStr)}</span>
</h1>
${dataCutoffText ? `<p style="margin:0;font-size:13px;color:#4a6585;line-height:1.5;display:flex;align-items:center;">🕐 <span style="margin-left:4px;">${escapeHtml(dataCutoffText)}</span></p>` : ''}
</td>
<td class="header-deco" width="170" style="padding:24px 22px 0 0;vertical-align:top;text-align:right;">
<img src="data:image/svg+xml;base64,${HEADER_DECO_SVG_BASE64}" width="150" alt="" style="display:block;border:0;border-radius:14px;box-shadow:0 6px 20px rgba(26,115,232,0.18);">
</td>
</tr>
</table>
</td></tr>

<!-- Highlight cards -->
${highlightCardsHtml}

<!-- Spacer between cards and content -->
<tr><td style="background:${highlights.length > 0 ? 'linear-gradient(180deg,#f4f8ff 0%,#f0f4fa 100%)' : '#f0f4fa'};padding:14px 0 0;font-size:0;line-height:0;">&nbsp;</td></tr>

<!-- Content body with layered shadows -->
<tr><td style="background:#fff;border-radius:20px;box-shadow:0 16px 48px rgba(26,115,232,0.12),0 6px 20px rgba(26,115,232,0.07),0 1px 3px rgba(0,0,0,0.05),inset 0 1px 0 rgba(255,255,255,1);border:1px solid #e2ebf6;overflow:hidden;">
<div class="content-body" style="padding:32px 28px 24px;font-size:15px;line-height:1.85;word-break:break-word;color:#2c3e5a;">
${reportBody}
</div>
</td></tr>

<!-- Footer -->
<tr><td style="padding:20px 8px 6px;text-align:center;">
<p style="margin:0;font-size:12px;color:#7890ab;line-height:1.6;">生成时间：${escapeHtml(generatedAt)} · 内容用于研究与信息整理，不构成投资建议。</p>
</td></tr>

</table>
</td></tr>
</table>
</body></html>`;
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
    [/<h1>/g, `<h1 style="margin:0 0 22px;font-size:22px;line-height:1.4;color:#0d1b2a;font-weight:700;padding-bottom:12px;border-bottom:3px solid ${BRAND_BLUE_LIGHT};">`],
    [/<h2>/g, `<h2 style="margin:32px 0 16px;padding-bottom:10px;border-bottom:2px solid ${BRAND_BLUE_LIGHT};font-size:19px;line-height:1.5;color:${BRAND_BLUE};font-weight:700;">`],
    [/<h3>/g, `<h3 style="margin:28px 0 14px;font-size:17px;line-height:1.5;color:${BRAND_BLUE};font-weight:700;padding-left:12px;border-left:4px solid ${BRAND_BLUE};">`],
    [/<h4>/g, `<h4 style="margin:24px 0 12px;font-size:15px;line-height:1.5;color:${BRAND_BLUE_DARK};font-weight:600;">`],
    [/<p>/g, '<p style="margin:0 0 16px;line-height:1.9;color:#3a4d68;">'],
    [/<ol>/g, '<ol style="margin:10px 0 20px;padding-left:24px;color:#3a4d68;">'],
    [/<ul>/g, '<ul style="margin:10px 0 20px;padding-left:22px;color:#3a4d68;list-style-type:disc;">'],
    [/<li>/g, '<li style="margin:0 0 10px;line-height:1.85;color:#3a4d68;">'],
    [/<li style="margin:0 0 10px;line-height:1.85;color:#3a4d68"><strong>/g, `<li style="margin:0 0 10px;line-height:1.85;color:#3a4d68"><strong style="color:#0d1b2a;font-weight:700">`],
    [/<strong>/g, '<strong style="color:#0d1b2a;font-weight:700;">'],
    [/<blockquote>/g, `<blockquote style="margin:18px 0;padding:16px 20px;border-left:4px solid ${BRAND_BLUE};background:linear-gradient(90deg,${BRAND_BLUE_LIGHTER} 0%,#fff 100%);border-radius:0 12px 12px 0;color:#40546e;box-shadow:0 2px 8px rgba(26,115,232,0.06);">`],
    [/<code>/g, `<code style="padding:2px 7px;border-radius:6px;background:${BRAND_BLUE_LIGHTER};color:${BRAND_BLUE_DARK};font-family:Consolas,Monaco,monospace;font-size:13px;border:1px solid ${BRAND_BLUE_LIGHT};">`],
    [/<pre>/g, `<pre style="margin:16px 0;padding:18px;overflow:auto;border-radius:12px;background:#0d1b2a;color:#e8f0fe;white-space:pre-wrap;font-size:13px;line-height:1.7;box-shadow:inset 0 2px 8px rgba(0,0,0,0.3);">`],
    [/<hr>/g, `<hr style="margin:30px 0;border:0;border-top:1px solid #e2ebf6;">`],
    [/<a /g, `<a style="color:${BRAND_BLUE};text-decoration:underline;" `],
    [/<table>/g, `<div style="margin:18px 0;overflow-x:auto;border-radius:12px;border:1px solid #e2ebf6;overflow:hidden;box-shadow:0 2px 8px rgba(26,115,232,0.05);"><table style="width:100%;border-collapse:collapse;font-size:13px;">`],
    [/<\/table>/g, '</table></div>'],
    [/<th>/g, `<th style="padding:12px 14px;border:1px solid #e2ebf6;background:linear-gradient(180deg,${BRAND_BLUE_LIGHTER} 0%,${BRAND_BLUE_LIGHT} 100%);text-align:left;color:#0d1b2a;font-weight:600;">`],
    [/<td>/g, '<td style="padding:12px 14px;border:1px solid #eef2f7;vertical-align:top;color:#3a4d68;">'],
  ];
  for (const [pattern, replacement] of tags) html = html.replace(pattern, replacement);
  return html;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]!);
}
