import { describe, expect, it } from 'vitest';
import { validateAgentReport } from './reportValidator.js';

describe('validateAgentReport', () => {
  const safe = '<!doctype html><html><head><title>研究报告：测试</title><style>body{color:#222}</style></head><body><svg viewBox="0 0 10 10"></svg></body></html>';
  it('accepts bounded static reports', () => expect(validateAgentReport(safe, Buffer.byteLength(safe))).toEqual({ valid: true }));
  it.each(['<script>alert(1)</script>', '<img src="https://evil.test/x">', '<div onclick="evil()">x</div>', '<style>@import url(https://evil.test/x.css)</style>'])(
    'rejects active content: %s', fragment => {
      const html = safe.replace('</body>', `${fragment}</body>`);
      expect(validateAgentReport(html, Buffer.byteLength(html)).valid).toBe(false);
    },
  );
  it('rejects oversized reports', () => expect(validateAgentReport(safe, 11 * 1024 * 1024).valid).toBe(false));
  });

  it('allows only the static report charset and viewport metadata', () => {
    const safe = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>x</title></head></html>';
    expect(validateAgentReport(safe, Buffer.byteLength(safe))).toEqual({ valid: true });
    const refresh = '<!doctype html><html><head><meta http-equiv="refresh" content="0;url=https://example.com"><title>x</title></head></html>';
    expect(validateAgentReport(refresh, Buffer.byteLength(refresh)).valid).toBe(false);
  });
