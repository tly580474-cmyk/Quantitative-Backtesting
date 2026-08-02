import { createHash } from 'node:crypto';
import {
  authoritativeReplaySchema,
  screeningCandidateSchema,
  type AuthoritativeReplay,
  type ScreeningCandidate,
} from './schema.js';

export interface AuthoritativeReplayOutput {
  specHash: string;
  datasetHash: string;
  signalHash: string;
  result: unknown;
  orders: unknown[];
  rejectionCodes?: string[];
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/**
 * Replays a non-authoritative screening candidate through the TypeScript
 * engine. A candidate can only leave this function as passed when dataset,
 * spec and signal bindings all match and a human approval is attached.
 */
export async function executeAuthoritativeReplay(input: {
  candidate: unknown;
  humanApprovalId?: string;
  replay: (candidate: ScreeningCandidate) => Promise<AuthoritativeReplayOutput>;
  replayedAt?: Date;
}): Promise<AuthoritativeReplay> {
  const candidate = screeningCandidateSchema.parse(input.candidate);
  const output = await input.replay(candidate);
  const rejectionCodes = [...new Set(output.rejectionCodes ?? [])];
  if (output.specHash !== candidate.specHash) rejectionCodes.push('SPEC_HASH_MISMATCH');
  if (output.datasetHash !== candidate.datasetHash) rejectionCodes.push('DATASET_HASH_MISMATCH');
  if (output.signalHash !== candidate.signalHash) rejectionCodes.push('SIGNAL_HASH_MISMATCH');
  if (!input.humanApprovalId?.trim()) rejectionCodes.push('HUMAN_APPROVAL_REQUIRED');
  const passed = rejectionCodes.length === 0;
  return authoritativeReplaySchema.parse({
    protocolVersion: '1.0',
    candidateId: candidate.candidateId,
    specHash: candidate.specHash,
    datasetHash: candidate.datasetHash,
    engine: 'typescript_authoritative',
    status: passed ? 'passed' : 'rejected',
    ...(passed ? {
      resultHash: sha256(output.result),
      orderHash: sha256(output.orders),
      humanApprovalId: input.humanApprovalId!.trim(),
    } : {}),
    rejectionCodes,
    replayedAt: (input.replayedAt ?? new Date()).toISOString(),
  });
}
