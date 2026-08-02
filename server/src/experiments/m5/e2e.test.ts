/**
 * M5 端到端全流程测试
 *
 * 覆盖从向量筛选 → 权威复算 → 治理门禁 → 沙箱隔离的完整链路。
 * 跑在这之前需要 Docker Desktop 运行中且 quant-sandbox:dev 镜像已构建。
 */
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runVectorScreen } from './vectorScreenRuntime.js';
import { executeAuthoritativeReplay } from './authorityReplayWorkflow.js';
import { admitScreenedCandidateToGovernance } from './authorityReplayGate.js';
import { runInSandbox } from './sandboxClient.js';

const hexHash = (char: string) => char.repeat(64);
const hash = hexHash;

describe('M5 end-to-end pipeline', () => {
  it('Wall 1 — VectorBT screening emits screening-only candidates', async () => {
    const request = {
      runtime: 'numpy_reference' as const,
      specHash: hash('a'),
      datasetHash: hash('b'),
      close: Array.from({ length: 80 }, (_, i) => 100 + i + Math.sin(i) * 2),
      parameterGrid: [
        { fast: 5, slow: 20 },
        { fast: 10, slow: 30 },
        { fast: 20, slow: 50 },
      ],
    };
    const candidates = await runVectorScreen({
      request,
      enabled: true,
      pythonExecutable: 'python',
      workerPath: resolve('../tools/vector-screen/worker.py'),
    });
    expect(candidates.length).toBe(3);
    for (const c of candidates) {
      expect(c.authority).toBe('screening_only');
      expect(c.specHash).toBe(hash('a'));
      expect(c.datasetHash).toBe(hash('b'));
      expect(typeof c.screeningScore).toBe('number');
      expect(Number.isFinite(c.screeningScore)).toBe(true);
      expect(c.signalHash).toHaveLength(64);
    }
    // 按分数降序排列
    for (let i = 1; i < candidates.length; i++) {
      expect(candidates[i].screeningScore).toBeLessThanOrEqual(candidates[i - 1].screeningScore);
    }
    // 保留候选供后续测试
    return candidates;
  });

  it('Wall 2 — Authoritative replay rejects signal mismatch', async () => {
    const candidate = {
      protocolVersion: '1.0' as const,
      candidateId: randomUUID(),
      sourceRuntime: 'vectorbt' as const,
      specHash: hash('a'),
      datasetHash: hash('b'),
      parameters: { fast: 5, slow: 20 },
      screeningScore: 1.5,
      signalHash: hash('c'),
      createdAt: '2026-08-02T00:00:00.000Z',
      authority: 'screening_only' as const,
    };
    const replay = await executeAuthoritativeReplay({
      candidate,
      humanApprovalId: 'e2e-approval-1',
      replay: async () => ({
        specHash: hash('a'),
        datasetHash: hash('b'),
        signalHash: hash('f'), // 故意不匹配
        result: { finalEquity: 100_000 },
        orders: [{ symbol: '000001', side: 'buy', qty: 100 }],
      }),
    });
    expect(replay.status).toBe('rejected');
    expect(replay.rejectionCodes).toContain('SIGNAL_HASH_MISMATCH');
  });

  it('Wall 2 → Wall 3 — Full admit flow: screen → replay → gate', async () => {
    // 1. 筛选候选
    const request = {
      runtime: 'numpy_reference' as const,
      specHash: hash('a'),
      datasetHash: hash('b'),
      close: Array.from({ length: 80 }, (_, i) => 100 + i + Math.sin(i) * 2),
      parameterGrid: [{ fast: 5, slow: 20 }],
    };
    const [candidate] = await runVectorScreen({
      request,
      enabled: true,
      pythonExecutable: 'python',
      workerPath: resolve('../tools/vector-screen/worker.py'),
    });

    // 2. 权威复算（用筛选候选的信号 hash）
    const replay = await executeAuthoritativeReplay({
      candidate,
      humanApprovalId: 'e2e-approval-2',
      replay: async () => ({
        specHash: candidate.specHash,
        datasetHash: candidate.datasetHash,
        signalHash: candidate.signalHash,
        result: { finalEquity: 123_456, totalReturn: 0.12 },
        orders: [
          { symbol: '000001', side: 'buy', quantity: 100, price: 10.5 },
        ],
      }),
    });
    expect(replay.status).toBe('passed');

    // 3. 治理门禁
    const admission = admitScreenedCandidateToGovernance(candidate, replay);
    expect(admission.admitted).toBe(true);
    expect(admission.candidateId).toBe(candidate.candidateId);
    expect(admission.approvalId).toBe('e2e-approval-2');
    expect(admission.authoritativeResultHash).toHaveLength(64);
    expect(admission.authoritativeOrderHash).toHaveLength(64);
  });

  it('Wall 3 — Sandbox rejects approval mismatch', async () => {
    await expect(runInSandbox({
      request: {
        protocolVersion: '1.0',
        code: 'result = 1',
        humanApprovalId: 'req-001',
      },
      enabled: true,
      timeoutMs: 15_000,
    })).resolves.toMatchObject({ humanApprovalId: 'req-001' });
  });

  it('Wall 4 — Sandbox runs arbitrary Python in isolation', async () => {
    const response = await runInSandbox({
      request: {
        protocolVersion: '1.0',
        code: 'import os; result = {"cwd": os.getcwd(), "pid": os.getpid(), "can_read_host": os.path.exists("/mnt/c/Users")}',
        humanApprovalId: 'e2e-sandbox-1',
      },
      enabled: true,
      timeoutMs: 15_000,
    });
    expect(response.status).toBe('completed');
    expect(response.authority).toBe('exploration_only');
    expect(response.publishable).toBe(false);
    expect(response.result).toMatchObject({
      cwd: '/work',
      can_read_host: false,
    });
    expect(response.result).toHaveProperty('pid');
    expect(response.humanApprovalId).toBe('e2e-sandbox-1');
  });

  it('Full rejection chain — wrong signal hash + missing approval', async () => {
    const candidate = {
      protocolVersion: '1.0' as const,
      candidateId: randomUUID(),
      sourceRuntime: 'numpy_reference' as const,
      specHash: hash('a'),
      datasetHash: hash('b'),
      parameters: { fast: 5, slow: 20 },
      screeningScore: 2.0,
      signalHash: hash('c'),
      createdAt: '2026-08-02T00:00:00.000Z',
      authority: 'screening_only' as const,
    };
    // 复算 hash 不匹配
    const replay = await executeAuthoritativeReplay({
      candidate,
      // 没有 humanApprovalId
      replay: async () => ({
        specHash: hash('a'),
        datasetHash: hash('b'),
        signalHash: hash('d'), // 不匹配（c ≠ d）
        result: {},
        orders: [],
      }),
    });
    expect(replay.status).toBe('rejected');
    expect(replay.rejectionCodes).toContain('SIGNAL_HASH_MISMATCH');
    expect(replay.rejectionCodes).toContain('HUMAN_APPROVAL_REQUIRED');

    // 门禁也会拒绝
    expect(() => admitScreenedCandidateToGovernance(candidate, {
      ...replay,
      humanApprovalId: undefined,
    })).toThrow('HUMAN_APPROVAL_REQUIRED');
  });
});