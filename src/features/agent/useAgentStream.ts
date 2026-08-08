import { useState, useCallback, useRef } from 'react';
import type { AgentEvent, AgentStreamState } from './types';
import { API_BASE_URL } from '@/api/config';
import { getReportHtmlUrl } from './api';

export function useAgentStream() {
  const [state, setState] = useState<AgentStreamState>({
    events: [],
    status: 'idle',
    reportUrl: null,
    reportMeta: null,
  });
  const eventSourceRef = useRef<EventSource | null>(null);
  const lastSeqRef = useRef<number>(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runIdRef = useRef<string | null>(null);

  const connect = useCallback((
    runId: string,
    opts?: { keepEvents?: boolean; initialEvents?: AgentEvent[]; lastSeq?: number },
  ) => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }

    runIdRef.current = runId;
    lastSeqRef.current = opts?.lastSeq ?? 0;

    if (opts?.initialEvents) {
      setState({
        events: opts.initialEvents,
        status: 'connecting',
        reportUrl: null,
        reportMeta: null,
      });
    } else if (opts?.keepEvents) {
      // 追加模式：保留已有事件（继续对话场景），只更新状态
      setState(prev => ({
        ...prev,
        events: prev.events,
        status: 'connecting',
        reportUrl: null,
        reportMeta: null,
      }));
    } else {
      setState({
        events: [],
        status: 'connecting',
        reportUrl: null,
        reportMeta: null,
      });
    }

    const attachHandlers = (es: EventSource) => {
      es.onopen = () => {
        setState(prev => ({ ...prev, status: 'running' }));
      };

      es.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data) as AgentEvent;
          if (data.seq && data.seq > lastSeqRef.current) {
            lastSeqRef.current = data.seq;
          }
          setState(prev => ({
            ...prev,
            events: [...prev.events, data],
            status: data.type === 'done' ? 'completed' : prev.status,
          }));
        } catch {
          // ignore parse errors
        }
      };

      es.addEventListener('done', (e) => {
        try {
          const data = JSON.parse((e as MessageEvent).data);
          setState(prev => ({
            ...prev,
            status: data.exitCode === 0 ? 'completed' : 'failed',
          }));
        } catch {
          // ignore parse errors
        }
      });

      es.addEventListener('text', (e) => {
        try {
          const data = JSON.parse((e as MessageEvent).data);
          setState(prev => ({
            ...prev,
            reportMeta: { title: data.title, summary: data.summary },
            reportUrl: `${API_BASE_URL}${getReportHtmlUrl(runId)}`,
          }));
        } catch {
          // ignore parse errors
        }
      });

      es.onerror = () => {
        setState(prev => {
          if (
            prev.status === 'completed' ||
            prev.status === 'failed' ||
            prev.status === 'canceled'
          ) {
            return prev;
          }
          // Schedule reconnect after 3s
          if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
          reconnectTimerRef.current = setTimeout(() => {
            if (!runIdRef.current) return;
            const lastSeq = lastSeqRef.current;
            const url = lastSeq > 0
              ? `${API_BASE_URL}/api/agent/runs/${runIdRef.current}/stream?lastEventId=${lastSeq}`
              : `${API_BASE_URL}/api/agent/runs/${runIdRef.current}/stream`;
            const newEs = new EventSource(url);
            eventSourceRef.current = newEs;
            attachHandlers(newEs);
            setState(prev2 => ({ ...prev2, status: 'connecting' }));
          }, 3000);
          return { ...prev, status: 'connecting' as const };
        });
      };
    };

    const url = lastSeqRef.current > 0
      ? `${API_BASE_URL}/api/agent/runs/${runId}/stream?lastEventId=${lastSeqRef.current}`
      : `${API_BASE_URL}/api/agent/runs/${runId}/stream`;
    const es = new EventSource(url);
    eventSourceRef.current = es;
    attachHandlers(es);
  }, []);

  const disconnect = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    runIdRef.current = null;
    lastSeqRef.current = 0;
    setState({
      events: [],
      status: 'idle',
      reportUrl: null,
      reportMeta: null,
    });
  }, []);

  // 注入用户消息事件（用于继续对话时显示新的用户输入）
  const pushUserMessage = useCallback((text: string) => {
    setState(prev => ({
      ...prev,
      events: [...prev.events, {
        type: 'user',
        content: text,
        seq: -1,
        timestamp: new Date().toISOString(),
      } as AgentEvent],
    }));
  }, []);

  return { state, connect, disconnect, pushUserMessage };
}
