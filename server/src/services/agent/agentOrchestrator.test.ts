import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'mysql2/promise';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentOrchestrator } from './agentOrchestrator.js';
import { fundFlowEvidence } from './fundFlowReportGuard.js';
import type {
  AgentProvider, AgentProviderHealth, ProviderCompletion, ProviderEventSink, ProviderRun,
} from './providers/types.js';

class FakeProvider implements AgentProvider {
  sink?: ProviderEventSink;
  readonly id = 'codex' as const;
  readonly capabilities = {
    streaming: true, resume: true, cancel: true, approvals: false,
    sandbox: true, skills: false, mcp: false,
  };
  private resolve!: (completion: ProviderCompletion) => void;
  private completion = new Promise<ProviderCompletion>(resolve => { this.resolve = resolve; });

  health(): AgentProviderHealth {
    return { id: this.id, enabled: true, available: true, reason: null, capabilities: this.capabilities };
  }

  async start(_params: unknown, sink: ProviderEventSink): Promise<ProviderRun> {
    this.sink = sink;
    await sink.session('codex-thread');
    return {
      pid: 42,
      threadId: 'codex-thread',
      completion: this.completion,
      cancel: async () => { this.resolve({ status: 'interrupted', exitCode: null }); },
    };
  }

  complete(): void { this.resolve({ status: 'completed', exitCode: 0 }); }
  async shutdown(): Promise<void> {}
}

const tempRoots: string[] = [];
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function harness() {
  const terminalPayloads: Array<Record<string, unknown>> = [];
  let seq = 0;
  const execute = vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.includes('COALESCE(MAX(seq)')) return [[{ seq }]];
    if (sql.includes('INSERT INTO agent_events')) {
      seq += 1;
      const raw = values?.[7];
      if (typeof raw === 'string') terminalPayloads.push(JSON.parse(raw));
      return [{ affectedRows: 1 }];
    }
    return [{ affectedRows: 1 }];
  });
  const root = mkdtempSync(join(tmpdir(), 'agent-orchestrator-'));
  tempRoots.push(root);
  const provider = new FakeProvider();
  const orchestrator = new AgentOrchestrator({ execute } as unknown as Pool, {
    claudeWorkingDirectory: process.cwd(), claudePath: process.execPath, reportRoot: root,
    maxConcurrent: 1, defaultProvider: 'codex',
  }, [provider]);
  return { orchestrator, provider, terminalPayloads, execute, root };
}

describe('AgentOrchestrator provider contract', () => {
  it('replaces a tenfold fund-flow table error in both the public answer and saved report', async () => {
    const { orchestrator, provider, terminalPayloads, root } = harness();
    const publicEvents: any[] = [];
    orchestrator.addEventListener('run-guard', event => publicEvents.push(event));
    await orchestrator.start({ runId: 'run-guard', prompt: '最近5日主力资金流，前5只股票，生成报告', maxTurns: 1, timeoutMs: 5000 });
    await provider.sink!.reportDecision(true);
    const base = { publicContent: '', timestamp: new Date().toISOString(), toolUseId: 'data' };
    await provider.sink!.event({ ...base, type: 'tool_started', toolName: 'Bash', toolInput: 'node server/scripts/researchData.mjs fund-flows' });
    await provider.sink!.event({ ...base, type: 'tool_finished', toolFundFlowEvidence: fundFlowEvidence({
      kind: 'research-data', dataset: 'fund_flows', ok: true, usable: true, unit: '亿元', requested: { group: 'stock' },
      windowComplete: true, daily: [{ tradeDate: '2026-09-14', mainNetInYi: -165.2556, sampleCount: 5207, expectedCount: 5550 }],
      topInflow: [], topOutflow: [], source: { providers: [] },
    }) });
    const bad = '| 业务日期 | 主力净额（亿元） |\n|---|---:|\n| 2026-09-14 | -16.53 |';
    for (const type of ['progress', 'assistant_final'] as const) await provider.sink!.event({ type, publicContent: bad, timestamp: base.timestamp });
    provider.complete();
    for (let i = 0; i < 100 && orchestrator.isRunning('run-guard'); i++) await new Promise(resolve => setTimeout(resolve, 10));
    const final = publicEvents.find(event => event.type === 'assistant_final').publicContent;
    expect(final).toContain('未通过一致性检查');
    expect(final).toContain('-165.26');
    expect(JSON.stringify(publicEvents)).not.toContain('-16.53');
    expect(JSON.stringify(publicEvents)).not.toContain('toolFundFlowEvidence');
    expect(readFileSync(join(root, 'reports', 'run-guard.html'), 'utf8')).toContain('-165.26');
    expect(terminalPayloads).toEqual([expect.objectContaining({ status: 'completed', metrics: expect.objectContaining({ fundFlowReportFallbacks: 1 }) })]);
  });
  it('persists masked failures and terminal metrics with deduplicated tool starts', async () => {
    const { orchestrator, provider, terminalPayloads, execute } = harness();
    await orchestrator.start({ runId: 'run-metrics', prompt: 'test', maxTurns: 1, timeoutMs: 5000 });
    const base = { publicContent: '', timestamp: new Date().toISOString(), toolUseId: 'query' };
    await provider.sink!.event({ ...base, type: 'tool_started', toolName: 'Bash', toolInput: '{}' });
    await provider.sink!.event({ ...base, type: 'tool_started', toolName: 'Bash', toolInput: 'npm run duckdb -- query --file q.sql | tail -5' });
    await provider.sink!.event({ ...base, type: 'tool_finished', publicContent: '工具执行完成', toolResult: 'Binder Error: no column' });
    provider.complete();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(terminalPayloads).toEqual([expect.objectContaining({ metrics: expect.objectContaining({
      toolCalls: 1, failedToolCalls: 1, failureCategories: { query_error: 1 },
    }) })]);
    expect(execute.mock.calls.some(([sql, values]) => sql.includes('INSERT INTO agent_events')
      && values?.[2] === 'error' && String(values?.[3]).includes('query_error'))).toBe(true);
  });
  it('emits one canceled terminal after provider interruption', async () => {
    const { orchestrator, terminalPayloads } = harness();
    await orchestrator.start({ runId: 'run-cancel', prompt: 'test', maxTurns: 1, timeoutMs: 5_000 });
    await expect(orchestrator.cancel('run-cancel')).resolves.toBe(true);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(terminalPayloads).toEqual([expect.objectContaining({ status: 'canceled', exitCode: null, errorCode: 'CANCELED', metrics: expect.objectContaining({ version: 1 }) })]);
  });

  it('distinguishes timeout from user cancellation and keeps a unique terminal', async () => {
    const { orchestrator, terminalPayloads } = harness();
    await orchestrator.start({ runId: 'run-timeout', prompt: 'test', maxTurns: 1, timeoutMs: 10 });
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(terminalPayloads).toEqual([expect.objectContaining({ status: 'failed', exitCode: null, errorCode: 'TIMEOUT', metrics: expect.objectContaining({ version: 1 }) })]);
  });
});
