import { describe, expect, it } from 'vitest';
import {
  acceptanceStatus,
  allocateCategoryTargets,
  judgePassed,
  m1SyntheticCandidateSchema,
} from './m1SyntheticSchemas.js';

const passingJudge = {
  id: 'm1-0001',
  scores: {
    accuracy: 4,
    evidenceGrounding: 5,
    ambiguityHandling: 4,
    capabilityCompliance: 5,
    diversityNaturalness: 4,
  },
  violations: [],
  reason: '通过',
};

describe('M1 synthetic corpus rules', () => {
  it('requires both independent judges to pass', () => {
    expect(judgePassed(passingJudge)).toBe(true);
    expect(acceptanceStatus(passingJudge, passingJudge)).toBe('accepted');
    expect(acceptanceStatus(passingJudge, {
      ...passingJudge,
      violations: ['臆造止盈条件'],
    })).toBe('rejected');
  });

  it('allocates the approved 200-item strata exactly', () => {
    expect(allocateCategoryTargets(200)).toEqual({
      complete: 70,
      partial: 50,
      short_colloquial: 25,
      conflicting: 25,
      unsupported: 30,
    });
    expect(Object.values(allocateCategoryTargets(7)).reduce((a, b) => a + b, 0)).toBe(7);
  });

  it('rejects clarification labels without a clarification question', () => {
    const parsed = m1SyntheticCandidateSchema.safeParse({
      sourceText: '做一个均线策略',
      category: 'partial',
      expectedDisposition: 'needs_clarification',
      extractedFacts: [],
      assumptions: [],
      clarifications: [],
      unsupportedCapabilities: [],
      prohibitedInferences: ['不得猜测均线周期'],
      tags: ['ma'],
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects empty fact values and fabricated evidence quotes before model judging', () => {
    const base = {
      sourceText: 'RSI低于30买入',
      category: 'complete',
      expectedDisposition: 'structured',
      assumptions: [],
      clarifications: [],
      unsupportedCapabilities: [],
      prohibitedInferences: [],
      tags: ['rsi'],
    } as const;
    expect(m1SyntheticCandidateSchema.safeParse({
      ...base,
      extractedFacts: [{
        path: 'entry',
        semanticType: 'entry_condition',
        value: '',
        evidenceQuote: 'RSI低于30',
      }],
    }).success).toBe(false);
    expect(m1SyntheticCandidateSchema.safeParse({
      ...base,
      extractedFacts: [{
        path: 'entry',
        semanticType: 'entry_condition',
        value: 30,
        evidenceQuote: '原文不存在',
      }],
    }).success).toBe(false);
  });
});
