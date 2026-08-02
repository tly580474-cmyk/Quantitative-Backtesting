import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  eventEngineTradeSchema,
  type EventEngineResult,
} from './eventEngineRuntime.js';

// N1.4：双引擎复算流程（ADR-05）。
// 事件引擎只产出 `screening_only` 成交记录；候选必须经权威 TS 引擎
// 复算（spec/dataset 绑定一致 + 成交/结果 hash 一致 + 人工审批）后
// 才能进入治理。事件引擎自身结果永不直接发布。

export const eventEngineCandidateSchema = z.object({
  protocolVersion: z.literal('1.0'),
  candidateId: z.string().uuid(),
  sourceRuntime: z.literal('backtrader'),
  specHash: z.string().regex(/^[a-f0-9]{64}$/),
  datasetHash: z.string().regex(/^[a-f0-9]{64}$/),
  strategyType: z.string().min(1),
  parameters: z.record(z.string(), z.union([z.number().finite(), z.boolean(), z.string()])),
  finalEquity: z.number().finite(),
  tradeHash: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.string().datetime(),
  authority: z.literal('screening_only'),
  publishable: z.literal(false),
});

export type EventEngineCandidate = z.infer<typeof eventEngineCandidateSchema>;

export const eventEngineReplaySchema = z.object({
  protocolVersion: z.literal('1.0'),
  candidateId: z.string().uuid(),
  specHash: z.string().regex(/^[a-f0-9]{64}$/),
  datasetHash: z.string().regex(/^[a-f0-9]{64}$/),
  engine: z.literal('typescript_authoritative'),
  status: z.enum(['passed', 'rejected']),
  resultHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  orderHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  rejectionCodes: z.array(z.string().min(1)).default([]),
  humanApprovalId: z.string().min(1).optional(),
  replayedAt: z.string().datetime(),
}).superRefine((value, ctx) => {
  if (value.status === 'passed' && (!value.resultHash || !value.orderHash)) {
    ctx.addIssue({ code: 'custom', path: ['resultHash'], message: '权威复算通过时必须提供结果与订单哈希' });
  }
  if (value.status === 'rejected' && value.rejectionCodes.length === 0) {
    ctx.addIssue({ code: 'custom', path: ['rejectionCodes'], message: '拒绝结果必须提供原因代码' });
  }
});

export type EventEngineReplay = z.infer<typeof eventEngineReplaySchema>;

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

/** 由事件引擎原始输出构造不可变候选（trades 摘要 hash + 参数绑定）。 */
export function buildEventEngineCandidate(input: {
  request: { specHash: string; datasetHash: string };
  strategyType: string;
  parameters: Record<string, number | boolean | string>;
  result: EventEngineResult;
  createdAt?: Date;
}): EventEngineCandidate {
  const tradeHash = sha256(input.result.trades.map((trade) => ({
    time: trade.time,
    side: trade.side,
    quantity: trade.quantity,
    rawPrice: trade.rawPrice,
    fillPrice: trade.fillPrice,
    commission: trade.commission,
    tax: trade.tax,
  })));
  return eventEngineCandidateSchema.parse({
    protocolVersion: '1.0',
    candidateId: randomUUID(),
    sourceRuntime: 'backtrader',
    specHash: input.request.specHash,
    datasetHash: input.request.datasetHash,
    strategyType: input.strategyType,
    parameters: input.parameters,
    finalEquity: input.result.finalEquity,
    tradeHash,
    createdAt: (input.createdAt ?? new Date()).toISOString(),
    authority: 'screening_only',
    publishable: false,
  });
}

/**
 * 双引擎复算：事件引擎候选经权威 TS 引擎复算后生成复算记录。
 * 复算必须由调用方用权威引擎重新执行相同 spec/dataset 并返回结果；
 * 本函数校验 spec/dataset 绑定、trade hash 与人工审批。
 */
export async function executeEventEngineReplay(input: {
  candidate: unknown;
  humanApprovalId?: string;
  replay: (candidate: EventEngineCandidate) => Promise<{
    specHash: string;
    datasetHash: string;
    tradeHash: string;
    result: unknown;
    orders: unknown[];
    rejectionCodes?: string[];
  }>;
  replayedAt?: Date;
}): Promise<EventEngineReplay> {
  const candidate = eventEngineCandidateSchema.parse(input.candidate);
  const output = await input.replay(candidate);
  const rejectionCodes = [...new Set(output.rejectionCodes ?? [])];
  if (output.specHash !== candidate.specHash) rejectionCodes.push('SPEC_HASH_MISMATCH');
  if (output.datasetHash !== candidate.datasetHash) rejectionCodes.push('DATASET_HASH_MISMATCH');
  if (output.tradeHash !== candidate.tradeHash) rejectionCodes.push('TRADE_HASH_MISMATCH');
  if (!input.humanApprovalId?.trim()) rejectionCodes.push('HUMAN_APPROVAL_REQUIRED');
  const passed = rejectionCodes.length === 0;
  return eventEngineReplaySchema.parse({
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

export interface EventEngineGovernanceAdmission {
  admitted: true;
  candidateId: string;
  authoritativeResultHash: string;
  authoritativeOrderHash: string;
  approvalId: string;
}

export function admitEventEngineCandidateToGovernance(
  rawCandidate: unknown,
  rawReplay: unknown,
): EventEngineGovernanceAdmission {
  const candidate: EventEngineCandidate = eventEngineCandidateSchema.parse(rawCandidate);
  const replay: EventEngineReplay = eventEngineReplaySchema.parse(rawReplay);
  if (candidate.authority !== 'screening_only' || candidate.publishable !== false) {
    throw new Error('EVENT_ENGINE_AUTHORITY_INVALID');
  }
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
