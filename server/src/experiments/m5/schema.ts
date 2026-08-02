import { z } from 'zod';

export const screeningCandidateSchema = z.object({
  protocolVersion: z.literal('1.0'),
  candidateId: z.string().uuid(),
  sourceRuntime: z.enum(['vectorbt', 'numpy_reference']),
  specHash: z.string().regex(/^[a-f0-9]{64}$/),
  datasetHash: z.string().regex(/^[a-f0-9]{64}$/),
  parameters: z.record(z.string(), z.union([z.number().finite(), z.boolean(), z.string()])),
  screeningScore: z.number().finite(),
  signalHash: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.string().datetime(),
  authority: z.literal('screening_only'),
});

export const authoritativeReplaySchema = z.object({
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

export type ScreeningCandidate = z.infer<typeof screeningCandidateSchema>;
export type AuthoritativeReplay = z.infer<typeof authoritativeReplaySchema>;
