import { describe, expect, it } from 'vitest';
import { sanitizeToolDetail } from './eventProtocol.js';
import { codexToolDetails } from './providers/codexAgentProvider.js';
import { parseStreamLine } from './outputParser.js';
import { buildPrompt } from './promptBuilder.js';
describe('public tool details', () => {
  it('redacts JSON credentials, headers and private keys while retaining useful results', () => {
    const detail = sanitizeToolDetail({ command: 'query bars', password: 'abc123', api_key: 'xyz789',
      output: 'rows=42 Authorization: Bearer abc.def.ghi\n-----BEGIN PRIVATE KEY-----\nprivate\n-----END PRIVATE KEY-----' });
    expect(detail).toContain('query bars');
    expect(detail).toContain('rows=42');
    for (const secret of ['abc123', 'xyz789', 'abc.def.ghi', 'BEGIN PRIVATE KEY']) expect(detail).not.toContain(secret);
    expect(sanitizeToolDetail('x'.repeat(15000))).toContain('内容已截断');
  });
  it('captures Codex commands, exit status and output without provider reasoning', () => {
    const result = codexToolDetails({ type: 'commandExecution', command: 'node tool.mjs catalog',
      exitCode: 0, aggregatedOutput: 'rows=42', reasoning: 'private internal text' });
    expect(result.toolInput).toBe('node tool.mjs catalog');
    expect(result.toolResult).toContain('rows=42');
    expect(JSON.stringify(result)).not.toContain('private internal');
  });
  it('retains complete Claude input after the partial lifecycle marker', () => {
    const full = parseStreamLine(JSON.stringify({ type: 'assistant', message: { content: [
      { type: 'tool_use', id: 'c1', name: 'Bash', input: { command: 'node tool.mjs catalog' } },
    ] } }));
    expect(full[0].toolInput).toContain('node tool.mjs catalog');
  });
  it.each(['claude', 'codex'] as const)('gives %s the same research routing', provider => {
    const prompt = buildPrompt('研究', 'D:/workspace', 'classic-blue', false, provider);
    expect(prompt).toContain('researchData.mjs');
    expect(prompt).toContain('全市场历史规律、筛选和因子验证优先 DuckDB');
  });
});
