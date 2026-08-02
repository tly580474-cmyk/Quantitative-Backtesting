import { describe, expect, it } from 'vitest';
import {
  admitEventEngineCandidateToGovernance,
  buildEventEngineCandidate,
  executeEventEngineReplay,
  type EventEngineCandidate,
} from './eventEngineReplay.js';
import type { EventEngineResult } from './eventEngineRuntime.js';

const hash = (char: string) => char.repeat(64);

function sampleResult(): EventEngineResult {
  return {
    protocolVersion: '1.0',
    runtime: 'backtrader',
    authority: 'screening_only',
    publishable: false,
    trades: [
      { time: '2025-02-13', side: 'buy', quantity: 1000, rawPrice: 97.3482, fillPrice: 97.3774, commission: 29.2132, tax: 0, amount: 97377.4045 },
      { time: '2025-03-07', side: 'sell', quantity: 1000, rawPrice: 105.9748, fillPrice: 105.943, commission: 31.7829, tax: 105.943, amount: 105943.0076 },
    ],
    orders: [],
    equityCurve: [{ time: '2025-02-13', equity: 100000 }, { time: '2025-03-07', equity: 101000 }],
    finalEquity: 101000,
  };
}

function makeCandidate(): EventEngineCandidate {
  return buildEventEngineCandidate({
    request: { specHash: hash('a'), datasetHash: hash('b') },
    strategyType: 'dual_ma',
    parameters: { fast: 5, slow: 20 },
    result: sampleResult(),
  });
}

describe('N1.4 event engine authoritative replay', () => {
  it('builds an immutable screening-only candidate with trade hash', () => {
    const candidate = makeCandidate();
    expect(candidate.sourceRuntime).toBe('backtrader');
    expect(candidate.authority).toBe('screening_only');
    expect(candidate.publishable).toBe(false);
    expect(candidate.tradeHash).toHaveLength(64);
    expect(candidate.finalEquity).toBe(101000);
  });

  it('passes replay when bindings, trade hash and approval match', async () => {
    const candidate = makeCandidate();
    const replay = await executeEventEngineReplay({
      candidate,
      humanApprovalId: 'approval-1',
      replay: async () => ({
        specHash: candidate.specHash,
        datasetHash: candidate.datasetHash,
        tradeHash: candidate.tradeHash,
        result: { finalEquity: candidate.finalEquity },
        orders: [{ symbol: '000001', side: 'buy', quantity: 1000 }],
      }),
    });
    expect(replay.status).toBe('passed');
    expect(replay.engine).toBe('typescript_authoritative');
    expect(replay.resultHash).toHaveLength(64);
    expect(replay.orderHash).toHaveLength(64);
  });

  it('rejects when trade hash mismatches', async () => {
    const candidate = makeCandidate();
    const replay = await executeEventEngineReplay({
      candidate,
      humanApprovalId: 'approval-1',
      replay: async () => ({
        specHash: candidate.specHash,
        datasetHash: candidate.datasetHash,
        tradeHash: hash('f'),
        result: {},
        orders: [],
      }),
    });
    expect(replay.status).toBe('rejected');
    expect(replay.rejectionCodes).toContain('TRADE_HASH_MISMATCH');
  });

  it('rejects when human approval is missing', async () => {
    const candidate = makeCandidate();
    const replay = await executeEventEngineReplay({
      candidate,
      replay: async () => ({
        specHash: candidate.specHash,
        datasetHash: candidate.datasetHash,
        tradeHash: candidate.tradeHash,
        result: {},
        orders: [],
      }),
    });
    expect(replay.status).toBe('rejected');
    expect(replay.rejectionCodes).toContain('HUMAN_APPROVAL_REQUIRED');
  });

  it('admits to governance only after passed replay with approval', async () => {
    const candidate = makeCandidate();
    const replay = await executeEventEngineReplay({
      candidate,
      humanApprovalId: 'approval-2',
      replay: async () => ({
        specHash: candidate.specHash,
        datasetHash: candidate.datasetHash,
        tradeHash: candidate.tradeHash,
        result: { finalEquity: candidate.finalEquity },
        orders: [],
      }),
    });
    const admission = admitEventEngineCandidateToGovernance(candidate, replay);
    expect(admission.admitted).toBe(true);
    expect(admission.approvalId).toBe('approval-2');
  });

  it('blocks admission when candidate is not screening-only', async () => {
    // authority 字段在 schema 层即被拒绝，无法进入复算与治理
    const candidate = { ...makeCandidate(), authority: 'exploration_only' as const };
    await expect(executeEventEngineReplay({
      candidate,
      humanApprovalId: 'approval-3',
      replay: async () => ({
        specHash: candidate.specHash,
        datasetHash: candidate.datasetHash,
        tradeHash: candidate.tradeHash,
        result: {},
        orders: [],
      }),
    })).rejects.toThrow();
    // publishable 必须为 false，否则同样被 schema 拒绝
    const publishableCandidate = { ...makeCandidate(), publishable: true as const };
    await expect(executeEventEngineReplay({
      candidate: publishableCandidate,
      humanApprovalId: 'approval-3',
      replay: async () => ({
        specHash: publishableCandidate.specHash,
        datasetHash: publishableCandidate.datasetHash,
        tradeHash: publishableCandidate.tradeHash,
        result: {},
        orders: [],
      }),
    })).rejects.toThrow();
  });
});
