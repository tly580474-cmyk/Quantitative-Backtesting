import { describe, expect, it } from 'vitest';
import type { AstFactorExpression } from '../definitions/schema.js';
import { buildCandidateSignatures } from './candidateSignature.js';

function expression(window: number, constant: number): AstFactorExpression {
  return {
    type: 'ast',
    version: 1,
    root: {
      type: 'operator',
      op: 'add',
      args: [
        {
          type: 'operator',
          op: 'ts_mean',
          window,
          args: [{ type: 'terminal', name: 'returns' }],
        },
        { type: 'constant', value: constant },
      ],
    },
  };
}

describe('candidate signatures', () => {
  it('keeps exact formulas unique but groups nearby windows and constants into one direction family', () => {
    const first = buildCandidateSignatures(expression(10, 1), 'higher-is-better');
    const related = buildCandidateSignatures(expression(15, 2), 'higher-is-better');
    expect(first.signature).not.toBe(related.signature);
    expect(first.familySignature).toBe(related.familySignature);
    expect(first.familySignature).toBe(
      '222684749b85e5377a2c670adfbbadb147327fd0924fc31471465e0e83e381db',
    );
  });

  it('does not blacklist the opposite predictive direction', () => {
    const higher = buildCandidateSignatures(expression(10, 1), 'higher-is-better');
    const lower = buildCandidateSignatures(expression(10, 1), 'lower-is-better');
    expect(higher.familySignature).not.toBe(lower.familySignature);
  });
});
