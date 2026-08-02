import { describe, expect, it } from 'vitest';
import { runInSandbox } from './sandboxClient.js';

describe('M5 Docker sandbox client', () => {
  it('is disabled unless explicitly enabled', async () => {
    await expect(runInSandbox({
      request: {
        protocolVersion: '1.0',
        code: 'result = 1',
        humanApprovalId: 'test',
      },
      enabled: false,
    })).rejects.toThrow('ARBITRARY_PYTHON_DISABLED');
  });

  it('executes code and returns structured result', async () => {
    const response = await runInSandbox({
      request: {
        protocolVersion: '1.0',
        code: 'result = {"hello": "sandbox", "pid": __import__("os").getpid()}',
        humanApprovalId: 'test-001',
      },
      enabled: true,
      timeoutMs: 30_000,
    });
    expect(response.status).toBe('completed');
    expect(response.authority).toBe('exploration_only');
    expect(response.publishable).toBe(false);
    expect(response.codeHash).toHaveLength(64);
    expect(response.resultHash).toHaveLength(64);
    expect(response.result).toMatchObject({ hello: 'sandbox' });
  });

  it('rejects code that tries to access host filesystem', async () => {
    const response = await runInSandbox({
      request: {
        protocolVersion: '1.0',
        code: 'import os; result = {"can_read": os.path.exists("/mnt/c/Users")}',
        humanApprovalId: 'test-002',
      },
      enabled: true,
      timeoutMs: 30_000,
    });
    expect(response.status).toBe('completed');
    expect(response.result).toMatchObject({ can_read: false });
  });

  it('blocks fork bomb via pids limit', async () => {
    const response = await runInSandbox({
      request: {
        protocolVersion: '1.0',
        code: 'import os; [os.fork() for _ in range(100)]; result = True',
        humanApprovalId: 'test-003',
      },
      enabled: true,
      timeoutMs: 30_000,
    });
    expect(response.status).toBe('failed');
    expect(response.error?.type).toBe('BlockingIOError');
  });
});