export type FactorCandidateStatus = 'draft' | 'frozen' | 'testing' | 'tested' | 'rejected' | 'approved';

const ALLOWED: Record<FactorCandidateStatus, FactorCandidateStatus[]> = {
  draft: ['frozen', 'rejected'],
  frozen: ['testing', 'rejected'],
  testing: ['tested', 'rejected'],
  tested: ['approved', 'rejected'],
  rejected: [],
  approved: [],
};

export function assertCandidateTransition(
  from: FactorCandidateStatus,
  to: FactorCandidateStatus,
  context: { lockedTestMetrics?: unknown; approvedBy?: string; rejectionReason?: string } = {},
): void {
  if (!ALLOWED[from].includes(to)) throw new Error(`候选状态不允许从 ${from} 变更为 ${to}`);
  if (to === 'tested' && !context.lockedTestMetrics) throw new Error('锁定测试完成后才能标记为 tested');
  if (to === 'approved' && !context.approvedBy?.trim()) throw new Error('人工批准必须记录审批人');
  if (to === 'rejected' && !context.rejectionReason?.trim()) throw new Error('拒绝候选必须填写原因');
}
