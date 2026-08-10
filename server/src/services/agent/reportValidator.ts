const MAX_REPORT_BYTES = 10 * 1024 * 1024;

export interface ReportValidation { valid: boolean; reason?: string; }

export function validateAgentReport(html: string, bytes: number): ReportValidation {
  if (bytes <= 0 || bytes > MAX_REPORT_BYTES) return { valid: false, reason: '报告大小不符合限制' };
  if (!/^\s*<!doctype html>/i.test(html) || !/<html\b/i.test(html) || !/<title>[^<]+<\/title>/i.test(html)) {
    return { valid: false, reason: '报告 HTML 结构不完整' };
  }
  if (/<(?:script|iframe|object|embed|form|base|meta|link)\b/i.test(html)) {
    return { valid: false, reason: '报告包含主动内容' };
  }
  if (/\son\w+\s*=|(?:href|src)\s*=\s*["']\s*(?:javascript:|https?:|\/\/)/i.test(html)) {
    return { valid: false, reason: '报告包含危险 URL 或事件处理器' };
  }
  if (/https?:\/\/|@import\b|url\(\s*["']?(?!data:)/i.test(html)) {
    return { valid: false, reason: '报告包含外部资源' };
  }
  return { valid: true };
}
