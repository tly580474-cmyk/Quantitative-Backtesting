import { describe, expect, it } from 'vitest';
import { sanitizePublicContent } from './eventProtocol.js';
import { parseStreamLine } from './outputParser.js';

describe('agent protocol load limits', () => {
  it('truncates a 1 MiB provider payload without retaining the tail', () => {
    const raw = `safe-prefix ${'x'.repeat(1024 * 1024)} SECRET_TAIL`;
    const started = performance.now();
    const result = sanitizePublicContent(raw);
    expect(result.length).toBeLessThan(12_100);
    expect(result).not.toContain('SECRET_TAIL');
    expect(performance.now() - started).toBeLessThan(250);
  });

  it('parses ten thousand public blocks in bounded time', () => {
    const line = JSON.stringify({ type: 'assistant', message: { content: Array.from({ length: 10_000 }, (_, index) => (
      index % 2 ? { type: 'tool_use', id: `tool-${index}`, name: 'Read', input: { huge: 'not persisted' } }
        : { type: 'text', text: `progress ${index}` }
    )) } });
    const started = performance.now();
    const events = parseStreamLine(line);
    expect(events).toHaveLength(10_000);
    expect(JSON.stringify(events)).not.toContain('not persisted');
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
