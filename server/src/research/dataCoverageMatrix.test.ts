import { describe, expect, it } from 'vitest';
import { assessCoverage } from './dataCoverageMatrix.js';

describe('data coverage matrix', () => {
  it('classifies pass, warn and fail by threshold', () => {
    expect(assessCoverage(99, 100, 0.99).status).toBe('pass');
    expect(assessCoverage(96, 100, 0.99).status).toBe('warn');
    expect(assessCoverage(80, 100, 0.99).status).toBe('fail');
  });

  it('does not treat an empty dataset as covered', () => {
    expect(assessCoverage(0, 0, 0.99)).toEqual({ status: 'fail', coverage: 0 });
  });
});
