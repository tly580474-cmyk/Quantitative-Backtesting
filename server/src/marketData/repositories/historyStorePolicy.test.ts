import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  allowsLegacyFallback,
  allowsV2Read,
  configureHistoryStorePolicy,
  getHistoryStorePolicy,
} from './historyStorePolicy.js';

describe('historyStorePolicy', () => {
  it('supports legacy, gray and v2-only read modes', () => {
    assert.equal(allowsV2Read({ readMode: 'legacy', dualWrite: true }), false);
    assert.equal(allowsLegacyFallback({ readMode: 'legacy', dualWrite: true }), true);
    assert.equal(allowsV2Read({ readMode: 'prefer-v2', dualWrite: true }), true);
    assert.equal(allowsLegacyFallback({ readMode: 'prefer-v2', dualWrite: true }), true);
    assert.equal(allowsV2Read({ readMode: 'v2', dualWrite: false }), true);
    assert.equal(allowsLegacyFallback({ readMode: 'v2', dualWrite: false }), false);
  });

  it('returns a copy of the configured process policy', () => {
    configureHistoryStorePolicy({ readMode: 'v2', dualWrite: false });
    const policy = getHistoryStorePolicy();
    policy.dualWrite = true;
    assert.deepEqual(getHistoryStorePolicy(), { readMode: 'v2', dualWrite: false });
    configureHistoryStorePolicy({ readMode: 'prefer-v2', dualWrite: true });
  });
});
