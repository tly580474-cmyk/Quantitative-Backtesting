import { describe, expect, it } from 'vitest';
import { recoverCodexToolDetails } from './codexHistoryDetails.js';
describe('Codex historical detail recovery', () => {
  const rows = [
    { type: 'session_meta', payload: { id: 's1' } },
    { type: 'response_item', payload: { type: 'reasoning', text: 'private reasoning' } },
    { type: 'response_item', payload: { type: 'function_call', call_id: 'c1', arguments: '{"command":"node probe","token":"private-token"}' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'rows=42' } },
  ].map(row => JSON.stringify(row));
  it('matches calls and redacts secrets without recovering reasoning', () => {
    const recovered = recoverCodexToolDetails(rows, 's1');
    expect(recovered.size).toBe(1);
    expect(recovered.get('c1')?.toolInput).toContain('node probe');
    expect(recovered.get('c1')?.toolResult).toBe('rows=42');
    expect(JSON.stringify([...recovered])).not.toMatch(/private-token|private reasoning/);
  });
  it('rejects logs belonging to another session', () => {
    expect(() => recoverCodexToolDetails(rows, 's2')).toThrow('sessionId');
  });
});
