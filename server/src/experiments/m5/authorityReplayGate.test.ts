import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { admitScreenedCandidateToGovernance } from './authorityReplayGate.js';

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

const replay = {
  protocolVersion: '1.0' as const,
  candidateId: candidate.candidateId,
  specHash: candidate.specHash,
  datasetHash: candidate.datasetHash,
  engine: 'typescript_authoritative' as const,
  status: 'passed' as const,
  resultHash: hash('d'),
  orderHash: hash('e'),
  rejectionCodes: [],
  humanApprovalId: 'approval-1',
  replayedAt: '2026-08-02T00:01:00.000Z',
};

describe('M5 screening to authoritative replay gate', () => {
  it('admits only a matching, approved TypeScript replay', () => {
    expect(admitScreenedCandidateToGovernance(candidate, replay)).toMatchObject({
      admitted: true, candidateId: candidate.candidateId, approvalId: 'approval-1',
    });
  });

  it('rejects runtime results that were not replayed against the same dataset', () => {
    expect(() => admitScreenedCandidateToGovernance(candidate, {
      ...replay, datasetHash: hash('f'),
    })).toThrow('REPLAY_DATASET_HASH_MISMATCH');
  });

  it('rejects a passed replay without explicit human approval', () => {
    expect(() => admitScreenedCandidateToGovernance(candidate, {
      ...replay, humanApprovalId: undefined,
    })).toThrow('HUMAN_APPROVAL_REQUIRED');
  });
});
