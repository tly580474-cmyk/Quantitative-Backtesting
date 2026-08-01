import { describe, expect, it, vi } from 'vitest';
import {
  isTransientEmailError,
  renderMarkdownForEmail,
  reportEmailHtml,
  sendEmailWithRetry,
  type EmailDeliveryResult,
} from './emailSender.js';

describe('market opinion email HTML', () => {
  it('renders headings, emphasis, lists and tables instead of exposing markdown markers', () => {
    const markdown = '### 关键结论\n\n1. **风险偏好下降**\n   - 验证条件\n\n| 指标 | 数值 |\n| --- | --- |\n| MSI | -82 |';
    const body = renderMarkdownForEmail(markdown);
    expect(body).toContain('<h3 style=');
    expect(body).toContain('<strong style=');
    expect(body).toContain('<ol style=');
    expect(body).toContain('<table style=');
    expect(body).not.toContain('###');
    expect(body).not.toContain('**');
  });

  it('blocks raw HTML, remote images and unsafe links', () => {
    const html = reportEmailHtml('测试', '<script>alert(1)</script> ![x](https://tracker.test/a.png) [x](javascript:alert(1))', '2026-07-19 13:14');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('javascript:');
  });
});

function ok(): EmailDeliveryResult {
  return { messageId: '<ok@example.com>', accepted: ['to@example.com'], rejected: [], response: '250 OK' };
}

describe('isTransientEmailError', () => {
  it('treats network timeouts and connection resets as transient', () => {
    expect(isTransientEmailError(Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }))).toBe(true);
    expect(isTransientEmailError(Object.assign(new Error('socket time out'), { code: 'ESOCKETTIMEOUT' }))).toBe(true);
    expect(isTransientEmailError(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))).toBe(true);
  });

  it('treats SMTP 4xx responses as transient but 5xx as permanent', () => {
    expect(isTransientEmailError(Object.assign(new Error('421 Service not available'), { responseCode: 421 }))).toBe(true);
    expect(isTransientEmailError(Object.assign(new Error('550 Mailbox not found'), { responseCode: 550 }))).toBe(false);
  });

  it('does not retry auth failures or generic errors', () => {
    expect(isTransientEmailError(Object.assign(new Error('Invalid login'), { code: 'EAUTH' }))).toBe(false);
    expect(isTransientEmailError(new Error('something broke'))).toBe(false);
    expect(isTransientEmailError(null)).toBe(false);
  });
});

describe('sendEmailWithRetry', () => {
  it('returns the result when the first attempt succeeds without retrying', async () => {
    const sendOnce = vi.fn().mockResolvedValue(ok());
    await expect(sendEmailWithRetry(sendOnce, { retryDelayMs: 0 })).resolves.toMatchObject({ response: '250 OK' });
    expect(sendOnce).toHaveBeenCalledTimes(1);
  });

  it('retries transient failures and succeeds on a later attempt', async () => {
    const sendOnce = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }))
      .mockRejectedValueOnce(Object.assign(new Error('421 try later'), { responseCode: 421 }))
      .mockResolvedValueOnce(ok());
    await expect(sendEmailWithRetry(sendOnce, { maxAttempts: 3, retryDelayMs: 0 })).resolves.toMatchObject({ response: '250 OK' });
    expect(sendOnce).toHaveBeenCalledTimes(3);
  });

  it('does not retry permanent errors such as auth failure', async () => {
    const authError = Object.assign(new Error('Invalid login'), { code: 'EAUTH' });
    const sendOnce = vi.fn().mockRejectedValue(authError);
    await expect(sendEmailWithRetry(sendOnce, { maxAttempts: 3, retryDelayMs: 0 })).rejects.toBe(authError);
    expect(sendOnce).toHaveBeenCalledTimes(1);
  });

  it('gives up after maxAttempts transient failures', async () => {
    const sendOnce = vi.fn().mockRejectedValue(Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }));
    await expect(sendEmailWithRetry(sendOnce, { maxAttempts: 2, retryDelayMs: 0 })).rejects.toThrow('ETIMEDOUT');
    expect(sendOnce).toHaveBeenCalledTimes(2);
  });
});
