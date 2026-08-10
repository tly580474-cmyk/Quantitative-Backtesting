// @vitest-environment happy-dom
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AgentEventList } from './AgentEventList';
import type { AgentEvent } from './types';

describe('AgentEventList long conversation', () => {
  it('keeps a 100-turn / 10,000-process-event history interactive', () => {
    const events: AgentEvent[] = [];
    for (let turn = 0; turn < 100; turn += 1) {
      events.push({ type: 'user', content: `question ${turn}` });
      for (let step = 0; step < 100; step += 1) {
        events.push({ type: 'progress', content: `turn ${turn} step ${step}` });
      }
      events.push({ type: 'assistant_final', content: `answer ${turn}` });
      events.push({ type: 'terminal', content: '', terminal: { status: 'completed', exitCode: 0 } });
    }
    const started = performance.now();
    const view = render(<AgentEventList runId="load-run" userPrompt="" events={events} />);
    expect(view.getAllByRole('button', { name: /已处理/ })).toHaveLength(100);
    expect(view.getByText('answer 99')).toBeTruthy();
    // Closed folds do not materialize their 10,000 child rows in the DOM.
    expect(view.queryByText('turn 99 step 99')).toBeNull();
    expect(performance.now() - started).toBeLessThan(3_000);
  });
});
