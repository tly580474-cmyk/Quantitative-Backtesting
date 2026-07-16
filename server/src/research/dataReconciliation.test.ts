import { describe, expect, it } from 'vitest';
import { aggregateReconciliationStatus } from './dataReconciliation.js';

describe('data reconciliation', () => {
  it('passes only when every reconciliation check passes', () => {
    expect(aggregateReconciliationStatus([{ status: 'pass' }, { status: 'pass' }]))
      .toBe('pass');
    expect(aggregateReconciliationStatus([{ status: 'pass' }, { status: 'fail' }]))
      .toBe('fail');
  });
});
