import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { admitScreenedCandidateToGovernance } from './authorityReplayGate.js';
import { executeAuthoritativeReplay } from './authorityReplayWorkflow.js';

const hash = (char: string) => char.repeat(64);
const candidate = {
  protocolVersion: '1.0' as const,
  candidateId: randomUUID(),
  sourceRuntime: 'vectorbt' as const,
  specHash: hash('a'),
  datasetHash: hash('b'),
  parameters: { fast: 5, slow: 20 },
  screeningScore: 1.2,
  signalHash: hash('c'),
  createdAt: '2026-08-02T00:00:00.000Z',
  authority: 'screening_only' as const,
};

describe('M5 authoritative replay workflow', () => {
  it('replays, hashes and admits an approved matching candidate', async () => {
    const replay = await executeAuthoritativeReplay({
      candidate,
      humanApprovalId: 'approval-m5-1',
      replayedAt: new Date('2026-08-02T00:01:00.000Z'),
      replay: async () => ({
        specHash: candidate.specHash,
        datasetHash: candidate.datasetHash,
        signalHash: candidate.signalHash,
        result: { finalEquity: 123_456 },
        orders: [{ symbol: '000001', side: 'buy', quantity: 100 }],
      }),
    });
    expect(replay.status).toBe('passed');
    expect(admitScreenedCandidateToGovernance(candidate, replay)).toMatchObject({
      admitted: true,
      approvalId: 'approval-m5-1',
    });
  });

  it('rejects a candidate whose authoritative signal does not match', async () => {
    const replay = await executeAuthoritativeReplay({
      candidate,
      humanApprovalId: 'approval-m5-2',
      replay: async () => ({
        specHash: candidate.specHash,
        datasetHash: candidate.datasetHash,
        signalHash: hash('f'),
        result: {},
        orders: [],
      }),
    });
    expect(replay).toMatchObject({ status: 'rejected' });
    expect(replay.rejectionCodes).toContain('SIGNAL_HASH_MISMATCH');
  });
});
