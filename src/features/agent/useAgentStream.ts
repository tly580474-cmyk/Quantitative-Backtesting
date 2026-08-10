import { useState, useCallback, useRef, useEffect } from 'react';
import type { AgentEvent, AgentStreamState } from './types';
import { API_BASE_URL } from '@/api/config';
import { getAgentRun, getReportHtmlUrl, normalizeAgentEvent } from './api';

const FINAL = new Set(['completed', 'failed', 'canceled']);

export function useAgentStream() {
  const [state, setState] = useState<AgentStreamState>({ events: [], status: 'idle', reportUrl: null, reportMeta: null });
  const sourceRef = useRef<EventSource | null>(null);
  const lastSeqRef = useRef(0);
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runIdRef = useRef<string | null>(null);
  const generationRef = useRef(0);
  const retryRef = useRef(0);

  const reconcileCompletedRun = useCallback(async (runId: string, generation: number) => {
    const delays = [0, 500, 1_500, 3_000];
    for (const delay of delays) {
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      if (generation !== generationRef.current || runIdRef.current !== runId) return;
      try {
        const result = await getAgentRun(runId);
        setState(prev => {
          const incoming = new Map(result.events.filter(event => event.seq != null).map(event => [event.seq as number, event]));
          const seen = new Set<number>();
          const events = prev.events.map(event => {
            if (event.runId !== runId || event.seq == null || !incoming.has(event.seq)) return event;
            seen.add(event.seq);
            return incoming.get(event.seq) as AgentEvent;
          });
          for (const event of result.events) {
            if (event.seq != null && !seen.has(event.seq)) events.push(event);
          }
          const status = result.run.status === 'completed' || result.run.status === 'failed' || result.run.status === 'canceled'
            ? result.run.status : prev.status;
          return {
            ...prev,
            events,
            status,
            reportMeta: result.report ? { title: result.report.title, summary: result.report.summary ?? '' } : prev.reportMeta,
            reportUrl: result.report ? `${API_BASE_URL}${getReportHtmlUrl(runId)}` : prev.reportUrl,
          };
        });
        return;
      } catch { /* retry transient history/report visibility failures */ }
    }
  }, []);

  const close = useCallback(() => {
    sourceRef.current?.close(); sourceRef.current = null;
    if (reconnectRef.current) clearTimeout(reconnectRef.current);
    reconnectRef.current = null;
  }, []);

  useEffect(() => () => close(), [close]);

  const connect = useCallback((runId: string, opts?: { keepEvents?: boolean; initialEvents?: AgentEvent[]; lastSeq?: number }) => {
    close();
    const generation = ++generationRef.current;
    runIdRef.current = runId;
    lastSeqRef.current = opts?.lastSeq ?? 0;
    retryRef.current = 0;
    setState(prev => ({
      events: opts?.initialEvents ?? (opts?.keepEvents ? prev.events : []), status: 'connecting', reportUrl: null, reportMeta: null,
    }));

    const open = () => {
      if (generation !== generationRef.current || runIdRef.current !== runId) return;
      const params = lastSeqRef.current > 0 ? `?lastEventId=${lastSeqRef.current}` : '';
      const source = new EventSource(`${API_BASE_URL}/api/agent/runs/${runId}/stream${params}`);
      sourceRef.current = source;
      source.onopen = () => {
        retryRef.current = 0;
        setState(prev => FINAL.has(prev.status) ? prev : { ...prev, status: 'running' });
      };
      source.onmessage = message => {
        try {
          const raw = JSON.parse(message.data) as Record<string, unknown>;
          const event = normalizeAgentEvent(raw);
          const seq = typeof raw.seq === 'number' ? raw.seq : Number.parseInt(message.lastEventId, 10);
          if (!event || !Number.isFinite(seq) || seq <= lastSeqRef.current) return;
          lastSeqRef.current = seq;
          event.seq = seq;
          event.runId = event.runId ?? runId;
          setState(prev => {
            if (prev.events.some(existing => existing.runId === runId && existing.seq === seq && seq > 0)) return prev;
            const terminalStatus = event.type === 'terminal' ? event.terminal?.status : undefined;
            return { ...prev, events: [...prev.events, event], status: terminalStatus ?? prev.status };
          });
          if (event.type === 'terminal') {
            source.close();
            if (event.terminal?.status === 'completed') void reconcileCompletedRun(runId, generation);
          }
        } catch { /* malformed events are ignored */ }
      };
      source.onerror = () => {
        source.close();
        setState(prev => {
          if (FINAL.has(prev.status)) return prev;
          const delay = Math.min(30_000, 1_000 * (2 ** retryRef.current));
          retryRef.current += 1;
          if (!reconnectRef.current) reconnectRef.current = setTimeout(() => {
            reconnectRef.current = null; open();
          }, delay);
          return { ...prev, status: 'connecting' };
        });
      };
    };
    open();
  }, [close, reconcileCompletedRun]);

  const disconnect = useCallback(() => {
    generationRef.current++; close(); runIdRef.current = null; lastSeqRef.current = 0;
    setState({ events: [], status: 'idle', reportUrl: null, reportMeta: null });
  }, [close]);

  const hydrate = useCallback((
    runId: string,
    events: AgentEvent[],
    status: 'completed' | 'failed' | 'canceled',
    report?: { title: string; summary: string } | null,
  ) => {
    generationRef.current++; close(); runIdRef.current = runId;
    lastSeqRef.current = events.reduce((max, event) => Math.max(max, event.seq ?? 0), 0);
    setState({
      events, status,
      reportMeta: report ?? null,
      reportUrl: report ? `${API_BASE_URL}${getReportHtmlUrl(runId)}` : null,
    });
  }, [close]);

  const setReport = useCallback((runId: string, meta: { title: string; summary: string }) => {
    setState(prev => ({ ...prev, reportMeta: meta, reportUrl: `${API_BASE_URL}${getReportHtmlUrl(runId)}` }));
  }, []);

  return { state, connect, disconnect, hydrate, setReport };
}
