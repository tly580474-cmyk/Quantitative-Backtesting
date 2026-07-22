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
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head><body style="margin:0;background:#f3f6fa;color:#162033;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif"><main style="max-width:860px;margin:0 auto;padding:24px 14px"><section style="background:#fff;border:1px solid #dce4ee;border-radius:12px;overflow:hidden"><header style="padding:20px 24px;background:#0f2744;color:#fff"><div style="font-size:12px;opacity:.72">市场观点智能体</div><h1 style="font-size:22px;line-height:1.35;margin:6px 0 0;color:#fff">${escapeHtml(title)}</h1></header><div style="padding:22px 24px;font-size:15px;line-height:1.75;word-break:break-word">${reportBody}</div><footer style="border-top:1px solid #edf1f5;padding:12px 24px;color:#6b778c;font-size:12px">生成时间：${escapeHtml(generatedAt)} · 内容用于研究与信息整理，不构成投资建议。</footer></section></main></body></html>`;
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
