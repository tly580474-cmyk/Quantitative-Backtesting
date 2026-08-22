import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'mysql2/promise';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentOrchestrator } from './agentOrchestrator.js';
import type {
  AgentProvider, AgentProviderHealth, ProviderCompletion, ProviderEventSink, ProviderRun,
} from './providers/types.js';

class FakeProvider implements AgentProvider {
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
    wslProjectPath: '/workspace', claudePath: 'claude', reportRoot: root,
    maxConcurrent: 1, defaultProvider: 'codex',
  }, [provider]);
  return { orchestrator, provider, terminalPayloads };
}

describe('AgentOrchestrator provider contract', () => {
  it('emits one canceled terminal after provider interruption', async () => {
    const { orchestrator, terminalPayloads } = harness();
    await orchestrator.start({ runId: 'run-cancel', prompt: 'test', maxTurns: 1, timeoutMs: 5_000 });
    await expect(orchestrator.cancel('run-cancel')).resolves.toBe(true);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(terminalPayloads).toEqual([{ status: 'canceled', exitCode: null, errorCode: 'CANCELED' }]);
  });

  it('distinguishes timeout from user cancellation and keeps a unique terminal', async () => {
    const { orchestrator, terminalPayloads } = harness();
    await orchestrator.start({ runId: 'run-timeout', prompt: 'test', maxTurns: 1, timeoutMs: 10 });
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(terminalPayloads).toEqual([{ status: 'failed', exitCode: null, errorCode: 'TIMEOUT' }]);
  });
});
