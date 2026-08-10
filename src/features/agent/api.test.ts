import { describe, expect, it } from 'vitest';
import { normalizeAgentEvent } from './api';

describe('agent event compatibility adapter', () => {
  it('never exposes legacy thought records', () => {
    expect(normalizeAgentEvent({ eventType: 'thought', content: 'raw reasoning' })).toBeNull();
  });

  it('normalizes v2 public content', () => {
    expect(normalizeAgentEvent({ type: 'assistant_final', publicContent: '结论', seq: 9 }))
      .toMatchObject({ type: 'assistant_final', content: '结论', seq: 9 });
  });
});
