import { describe, expect, it } from 'vitest';
import { buildResearchContext } from './researchContext.js';
describe('research evidence reuse', () => {
  it('pairs persisted calls, preserves failures and excludes unrelated tools', () => {
    const events = [
      { runId: 'r1', toolUseId: '1', eventType: 'tool_started', toolInput: 'node server/scripts/researchData.mjs describe daily_bars' },
      { runId: 'r1', toolUseId: '1', eventType: 'tool_finished', toolResult: '{"snapshotId":"snapshot-1"}' },
      { runId: 'r1', toolUseId: '2', eventType: 'tool_started', toolInput: 'npm run duckdb -- query' },
      { runId: 'r1', toolUseId: '2', eventType: 'error', toolResult: '字段缺失 password=private-value' },
      { runId: 'r1', toolUseId: '3', eventType: 'tool_started', toolInput: 'unrelated-command' },
    ];
    const context = buildResearchContext(events);
    expect(context).toContain('snapshot-1');
    expect(context).toContain('"failed":true');
    expect(context).not.toContain('private-value');
    expect(context).not.toContain('unrelated-command');
    expect(buildResearchContext([])).toBe('');
  });
});
