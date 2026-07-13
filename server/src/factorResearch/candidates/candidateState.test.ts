import { describe, expect, it } from 'vitest';
import { assertCandidateTransition } from './candidateState.js';

describe('factor candidate release gate', () => {
  it('allows only draft -> frozen -> tested -> approved', () => {
    expect(() => assertCandidateTransition('draft', 'frozen')).not.toThrow();
    expect(() => assertCandidateTransition('frozen', 'testing')).not.toThrow();
    expect(() => assertCandidateTransition('testing', 'tested', {
      lockedTestMetrics: { sampleCount: 10_000, tradingDays: 100, rankIc: 0.03 },
    })).not.toThrow();
    expect(() => assertCandidateTransition('tested', 'approved', { approvedBy: 'researcher' })).not.toThrow();
  });

  it('prevents direct publication and incomplete test/approval gates', () => {
    expect(() => assertCandidateTransition('draft', 'approved', { approvedBy: 'x' })).toThrow();
    expect(() => assertCandidateTransition('testing', 'tested')).toThrow('锁定测试');
    expect(() => assertCandidateTransition('tested', 'approved')).toThrow('审批人');
  });

  it('requires a rejection reason', () => {
    expect(() => assertCandidateTransition('draft', 'rejected')).toThrow('原因');
    expect(() => assertCandidateTransition('draft', 'rejected', { rejectionReason: '重复因子' })).not.toThrow();
  });
});
