import { describe, expect, it } from 'vitest';
import { runInSandbox } from './sandboxClient.js';

// Docker 沙箱启动在并行全量回归下可能较慢，提高本组测试超时上限
describe('M5 Docker sandbox client', { timeout: 60_000 }, () => {
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

  it('N5.3 does not leak host environment variables into the sandbox', async () => {
    const response = await runInSandbox({
      request: {
        protocolVersion: '1.0',
        code: 'import os; result = {"secret_env": os.environ.get("N5_SECRET_ENV_PROBE")}',
        humanApprovalId: 'test-004',
      },
      enabled: true,
      timeoutMs: 30_000,
    });
    expect(response.status).toBe('completed');
    // 宿主环境变量不会透传进容器（容器内该变量为 None）
    expect(response.result).toMatchObject({ secret_env: null });
  });

  it('N5.3 blocks network access inside the sandbox', async () => {
    const response = await runInSandbox({
      request: {
        protocolVersion: '1.0',
        code: 'import socket; result = {"resolved": socket.gethostbyname("example.com")}',
        humanApprovalId: 'test-005',
      },
      enabled: true,
      timeoutMs: 30_000,
    });
    // --network=none：DNS 解析失败，代码抛异常 → status = failed
    expect(response.status).toBe('failed');
    expect(response.error).not.toBeNull();
  });

  it('N5.3 enforces a wall-clock timeout on infinite loops', async () => {
    await expect(runInSandbox({
      request: {
        protocolVersion: '1.0',
        code: 'while True: pass',
        humanApprovalId: 'test-006',
      },
      enabled: true,
      timeoutMs: 8_000,
    })).rejects.toThrow(/SANDBOX_CLIENT_FAILED|SIGKILL|timeout/i);
  }, 20_000);
});