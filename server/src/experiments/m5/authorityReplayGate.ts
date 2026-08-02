import {
  authoritativeReplaySchema,
  screeningCandidateSchema,
  type AuthoritativeReplay,
  type ScreeningCandidate,
} from './schema.js';

export interface GovernanceAdmission {
  admitted: true;
  candidateId: string;
  authoritativeResultHash: string;
  authoritativeOrderHash: string;
  approvalId: string;
}

export function admitScreenedCandidateToGovernance(
  rawCandidate: unknown,
  rawReplay: unknown,
): GovernanceAdmission {
  const candidate: ScreeningCandidate = screeningCandidateSchema.parse(rawCandidate);
  const replay: AuthoritativeReplay = authoritativeReplaySchema.parse(rawReplay);
  if (candidate.authority !== 'screening_only') throw new Error('SCREENING_AUTHORITY_INVALID');
  if (replay.candidateId !== candidate.candidateId) throw new Error('REPLAY_CANDIDATE_MISMATCH');
  if (replay.specHash !== candidate.specHash) throw new Error('REPLAY_SPEC_HASH_MISMATCH');
  if (replay.datasetHash !== candidate.datasetHash) throw new Error('REPLAY_DATASET_HASH_MISMATCH');
  if (replay.engine !== 'typescript_authoritative') throw new Error('REPLAY_ENGINE_NOT_AUTHORITATIVE');
  if (replay.status !== 'passed') throw new Error(`REPLAY_REJECTED:${replay.rejectionCodes.join(',')}`);
  if (!replay.humanApprovalId) throw new Error('HUMAN_APPROVAL_REQUIRED');
  return {
    admitted: true,
    candidateId: candidate.candidateId,
    authoritativeResultHash: replay.resultHash!,
    authoritativeOrderHash: replay.orderHash!,
    approvalId: replay.humanApprovalId,
  };
}
