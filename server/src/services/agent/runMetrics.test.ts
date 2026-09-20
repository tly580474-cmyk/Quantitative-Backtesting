import { describe, expect, it } from 'vitest';
import { AgentRunMetrics, claudeTelemetry } from './runMetrics.js';
import type { PublicAgentEvent } from './eventProtocol.js';

describe('research run metrics', () => {
  it('deduplicates partial starts, unions parallel spans and keeps unknown useful-data timing null', () => {
    let time = 1000;
    const metrics = new AgentRunMetrics(() => time);
    const event = (type: PublicAgentEvent['type'], id: string, fields: Partial<PublicAgentEvent> = {}) =>
      metrics.observe({ type, toolUseId: id, publicContent: '', timestamp: '', ...fields });
    time = 1100; event('tool_started', 'a');
    time = 1200; event('tool_started', 'a', { toolName: 'Bash', toolInput: 'node researchData.mjs query --sql "select 1"' });
    event('tool_started', 'b', { toolName: 'Bash', toolInput: 'node researchData.mjs catalog' });
    time = 1400; event('tool_finished', 'a', { toolResult: 'exit 0, unknown data' });
    time = 1500; event('error', 'b', { toolFailure: { category: 'invalid_argument', evidence: 'exit_status', reportedExitCode: 2 } });
    event('error', 'b');
    time = 1600;
    expect(metrics.snapshot()).toMatchObject({ toolCalls: 2, failedToolCalls: 1, toolWallMs: 400,
      unattributedMs: 200, firstValidDataMs: null, firstSuccessfulDataToolMs: 400,
      failureCategories: { invalid_argument: 1 }, phases: { data: { calls: 1, toolMs: 300 } } });
  });
  it('accepts only an explicit useful-data envelope and accounts for unfinished calls', () => {
    let time = 0; const metrics = new AgentRunMetrics(() => time);
    metrics.observe({ type: 'tool_started', toolUseId: 'd', toolInput: 'researchData.mjs fund-flows', publicContent: '', timestamp: '' });
    time = 50;
    metrics.observe({ type: 'tool_finished', toolUseId: 'd', toolResult: JSON.stringify({ kind: 'research-data', ok: true, usable: true }), publicContent: '', timestamp: '' });
    metrics.observe({ type: 'tool_started', toolUseId: 'pending', publicContent: '', timestamp: '' });
    time = 70;
    expect(metrics.snapshot()).toMatchObject({ firstValidDataMs: 50, unfinishedToolCalls: 1 });
  });
  it('replaces repeated message usage, accepts authoritative totals and ignores invalid values', () => {
    const metrics = new AgentRunMetrics();
    for (const n of [10, 20]) metrics.telemetry({ model: 'qwen3.8-flash', messageId: 'm', usageScope: 'message',
      usage: { inputTokens: 100, cachedInputTokens: 80, outputTokens: n } });
    expect(metrics.snapshot()).toMatchObject({ models: ['qwen3.8-flash'], usage: { outputTokens: 20 }, usageScope: 'observed_messages' });
    metrics.telemetry({ usageScope: 'provider_total', usage: { inputTokens: 200, cachedInputTokens: 150, outputTokens: 40 } });
    metrics.telemetry({ usageScope: 'provider_total', usage: { inputTokens: NaN, cachedInputTokens: 0, outputTokens: 1 } });
    expect(metrics.snapshot().usage?.outputTokens).toBe(40);
  });
  it('extracts only model and numeric usage metadata', () => {
    const result = claudeTelemetry(JSON.stringify({ type: 'assistant', message: {
      id: 'm', model: 'test-model', content: [{ type: 'thinking', thinking: 'private' }],
      usage: { input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 5, output_tokens: 2 },
    } }));
    expect(result?.usage?.inputTokens).toBe(35);
    expect(JSON.stringify(result)).not.toContain('private');
  });
});
