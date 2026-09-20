import { describe, expect, it } from 'vitest';
import { detectToolFailure, isExecutedCommand } from './toolOutcome.js';
import { parseStreamLine } from './outputParser.js';

describe('tool execution outcomes', () => {
  it('retains a zero pipeline exit while detecting its failed query', () => {
    expect(detectToolFailure('Binder Error: missing column', false, 0)).toEqual({
      category: 'query_error', evidence: 'output_signature', reportedExitCode: 0,
    });
    expect(detectToolFailure({ ok: false, error: 'DATA_UNAVAILABLE: no rows' }))
      .toMatchObject({ category: 'data_unavailable', evidence: 'structured_result' });
    expect(detectToolFailure('details unavailable', true, 2)).toMatchObject({ evidence: 'exit_status', reportedExitCode: 2 });
  });
  it('detects failures beyond the public output truncation limit', () => {
    const [event] = parseStreamLine(JSON.stringify({ type: 'user', message: { content: [{
      type: 'tool_result', tool_use_id: 'q', content: 'row\n'.repeat(4000) + 'Binder Error: bad column',
    }] } }));
    expect(event.toolResult).not.toContain('Binder Error');
    expect(event.toolFailure?.category).toBe('query_error');
  });
  it('captures valid data before a large JSON result is truncated for display', () => {
    const [event] = parseStreamLine(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'q',
      content: JSON.stringify({ kind: 'research-data', ok: true, usable: true, sample: ['x'.repeat(16000)] }),
    }] } }));
    expect(event.toolResult).toContain('内容已截断');
    expect(event.toolDataUsable).toBe(true);
  });
  it('does not treat data, warnings, or reading source files as failed execution', () => {
    expect(detectToolFailure('error_count=0\nWarning: missing optional field')).toBeUndefined();
    expect(detectToolFailure('The guide explains Binder Error: ...')).toBeUndefined();
    expect(isExecutedCommand('Read', 'source.ts')).toBe(false);
    expect(isExecutedCommand('Bash', 'rg "Binder Error" source.ts')).toBe(false);
    expect(isExecutedCommand('Bash', 'npm run duckdb -- query --file q.sql 2>&1 | tail -20')).toBe(true);
  });
});
