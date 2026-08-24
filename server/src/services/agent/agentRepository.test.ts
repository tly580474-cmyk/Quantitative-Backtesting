import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'mysql2/promise';
import { AgentRepository } from './agentRepository.js';

describe('AgentRepository state machine', () => {
  it('persists the selected provider with each run', async () => {
    const execute = vi.fn().mockResolvedValue([{ affectedRows: 1 }]);
    const repo = new AgentRepository({ execute } as unknown as Pool);
    await repo.createRun('run-codex', 'test', 5, 60_000, 'classic-blue', undefined, 'run-codex', 0, 'codex');
    const [sql, values] = execute.mock.calls[0];
    expect(sql).toContain('provider');
    expect(values).toContain('codex');
    expect(values).toContain('native');
  });

  it('guards transitions with the expected source states', async () => {
    const execute = vi.fn().mockResolvedValue([{ affectedRows: 1 }]);
    const repo = new AgentRepository({ execute } as unknown as Pool);
    await expect(repo.transitionRun('run-1', ['starting'], 'running', { pid: 42 })).resolves.toBe(true);
    const [sql, values] = execute.mock.calls[0];
    expect(sql).toContain("WHERE id = ? AND status IN (?)");
    expect(values).toContain('starting');
    expect(values).toContain(42);
  });

  it('does not report success when a terminal state rejected an update', async () => {
    const execute = vi.fn().mockResolvedValue([{ affectedRows: 0 }]);
    const repo = new AgentRepository({ execute } as unknown as Pool);
    await expect(repo.transitionRun('run-1', ['running'], 'completed')).resolves.toBe(false);
  });

  it('stores only public v2 fields and nulls legacy raw payload columns', async () => {
    const execute = vi.fn().mockResolvedValue([{ affectedRows: 1 }]);
    const repo = new AgentRepository({ execute } as unknown as Pool);
    await repo.addPublicEvent('run-1', 1, {
      type: 'tool_started', publicContent: '正在使用 Read', toolName: 'Read', toolUseId: 'call-1',
      timestamp: '2026-08-10T00:00:00.000Z',
    });
    const [sql, values] = execute.mock.calls[0];
    expect(sql).toContain('tool_input, tool_result');
    expect(sql).toContain('NULL, NULL');
    expect(JSON.stringify(values)).not.toContain('server/.env');
  });

  it('bounds event page size before embedding it in SQL', async () => {
    const execute = vi.fn().mockResolvedValue([[]]);
    const repo = new AgentRepository({ execute } as unknown as Pool);
    await repo.getEvents('run-1', 5, 99_999);
    expect(execute.mock.calls[0][0]).toContain('LIMIT 10000');
    expect(execute.mock.calls[0][1]).toEqual(['run-1', 5]);
  });

  it('maps terminal_json to the public terminal property', async () => {
    const execute = vi.fn().mockResolvedValue([[{
      id: 1, run_id: 'run-1', seq: 1, event_type: 'terminal', content: '',
      terminal_json: '{"status":"canceled","exitCode":null}', protocol_version: 2,
    }]]);
    const repo = new AgentRepository({ execute } as unknown as Pool);
    const events = await repo.getEvents('run-1');
    expect(events[0].terminal).toEqual({ status: 'canceled', exitCode: null });
  });

  it('deletes every run in a conversation in one transaction', async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce([[{ id: 'run-1' }, { id: 'run-2' }]])
      .mockResolvedValue([{ affectedRows: 2 }]);
    const connection = {
      beginTransaction: vi.fn(), execute, commit: vi.fn(), rollback: vi.fn(), release: vi.fn(),
    };
    const repo = new AgentRepository({ getConnection: vi.fn().mockResolvedValue(connection) } as unknown as Pool);

    await repo.deleteConversation('conversation-1');

    expect(connection.beginTransaction).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledTimes(6);
    expect(execute.mock.calls[0]?.[0]).toContain('FOR UPDATE');
    expect(execute.mock.calls[1]?.[0]).toContain('run_id IN (?, ?)');
    expect(execute.mock.calls[1]?.[1]).toEqual(['run-1', 'run-2']);
    expect(execute.mock.calls.at(-1)?.[0]).toContain('DELETE FROM agent_runs WHERE conversation_id');
    expect(connection.commit).toHaveBeenCalledOnce();
    expect(connection.rollback).not.toHaveBeenCalled();
    expect(connection.release).toHaveBeenCalledOnce();
  });
});
