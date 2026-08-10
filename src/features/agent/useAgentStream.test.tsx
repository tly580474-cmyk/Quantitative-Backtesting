// @vitest-environment happy-dom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAgentStream } from './useAgentStream';

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(public url: string) { FakeEventSource.instances.push(this); }
  close() { this.closed = true; }
}

describe('useAgentStream', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('deduplicates sequence numbers and trusts the terminal payload', () => {
    const { result } = renderHook(() => useAgentStream());
    act(() => result.current.connect('run-1'));
    const source = FakeEventSource.instances[0];
    act(() => source.onopen?.());
    expect(result.current.state.status).toBe('running');
    const emit = (data: unknown, id: string) => source.onmessage?.({ data: JSON.stringify(data), lastEventId: id } as MessageEvent);
    act(() => {
      emit({ type: 'progress', publicContent: '步骤', seq: 1 }, '1');
      emit({ type: 'progress', publicContent: '重复', seq: 1 }, '1');
      emit({ type: 'terminal', publicContent: '已取消', seq: 2,
        terminal: { status: 'canceled', exitCode: null, errorCode: 'CANCELED' } }, '2');
    });
    expect(result.current.state.events.map(event => event.content)).toEqual(['步骤', '已取消']);
    expect(result.current.state.status).toBe('canceled');
    expect(source.closed).toBe(true);
  });

  it('reconnects with the last sequence and closes on unmount', () => {
    vi.useFakeTimers();
    const { result, unmount } = renderHook(() => useAgentStream());
    act(() => result.current.connect('run-2'));
    const first = FakeEventSource.instances[0];
    act(() => first.onmessage?.({
      data: JSON.stringify({ type: 'progress', publicContent: '步骤', seq: 7 }), lastEventId: '7',
    } as MessageEvent));
    act(() => first.onerror?.());
    act(() => vi.advanceTimersByTime(1_000));
    expect(FakeEventSource.instances[1].url).toContain('lastEventId=7');
    const second = FakeEventSource.instances[1];
    unmount();
    expect(second.closed).toBe(true);
  });

  it('does not treat the same sequence from an earlier run as a duplicate', () => {
    const { result } = renderHook(() => useAgentStream());
    act(() => result.current.connect('new-run', {
      initialEvents: [{ type: 'progress', content: '旧回合', runId: 'old-run', seq: 1 }],
    }));
    const source = FakeEventSource.instances[0];
    act(() => source.onmessage?.({
      data: JSON.stringify({ type: 'progress', runId: 'new-run', publicContent: '新回合', seq: 1 }),
      lastEventId: '1',
    } as MessageEvent));
    expect(result.current.state.events.map(event => event.content)).toEqual(['旧回合', '新回合']);
  });

  it('reconciles the final answer and report after terminal without a browser refresh', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      run: { id: 'run-final', status: 'completed' },
      events: [{ type: 'assistant_final', runId: 'run-final', publicContent: '最终产物', seq: 2 }],
      report: { title: '产物报告', summary: '自动出现' },
    }), { status: 200, headers: { 'content-type': 'application/json' } })));
    const { result } = renderHook(() => useAgentStream());
    act(() => result.current.connect('run-final'));
    const source = FakeEventSource.instances[0];
    act(() => source.onmessage?.({
      data: JSON.stringify({ type: 'terminal', runId: 'run-final', publicContent: '', seq: 3,
        terminal: { status: 'completed', exitCode: 0 } }), lastEventId: '3',
    } as MessageEvent));
    await waitFor(() => expect(result.current.state.events.some(event => event.content === '最终产物')).toBe(true));
    expect(result.current.state.reportMeta).toEqual({ title: '产物报告', summary: '自动出现' });
    expect(result.current.state.reportUrl).toContain('/api/agent/reports/run-final/html');
  });
});
