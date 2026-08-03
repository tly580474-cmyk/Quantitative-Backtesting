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

  const connect = useCallback((runId: string) => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    setState({
      events: [],
      status: 'connecting',
      reportUrl: null,
      reportMeta: null,
    });

    const url = `${API_BASE_URL}/api/agent/runs/${runId}/stream`;
    const es = new EventSource(url);
    eventSourceRef.current = es;

    es.onopen = () => {
      setState(prev => ({ ...prev, status: 'running' }));
    };

    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data) as AgentEvent;
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
      setState(prev => ({
        ...prev,
        status: prev.status === 'completed' ? prev.status : 'failed',
      }));
    };
  }, []);

  const disconnect = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    setState({
      events: [],
      status: 'idle',
      reportUrl: null,
      reportMeta: null,
    });
  }, []);

  return { state, connect, disconnect };
}
