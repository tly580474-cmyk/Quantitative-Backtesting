import { describe, expect, it } from 'vitest';
import { factorAstRequiresMaterialization, validateAndAnalyzeFactorAst } from './factorAst.js';

describe('materialized factor routing', () => {
  const nested = {
    type: 'operator' as const, op: 'cs_neutralize', args: [
      { type: 'terminal' as const, name: 'amount' as const },
      { type: 'operator' as const, op: 'ts_min', window: 5,
        args: [{ type: 'terminal' as const, name: 'log_mktcap' as const }] },
    ],
  };

  it('keeps nested analytic factors valid but routes them to materialization', () => {
    expect(() => validateAndAnalyzeFactorAst(nested)).not.toThrow();
    expect(factorAstRequiresMaterialization(nested)).toBe(true);
  });

  it('keeps directly compilable factors on the SQL path', () => {
    expect(factorAstRequiresMaterialization({
      type: 'operator', op: 'ts_mean', window: 5,
      args: [{ type: 'terminal', name: 'returns' }],
    })).toBe(false);
  });
});
