import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../../db/schema.js';

const mocks = vi.hoisted(() => ({ locked: vi.fn(), insert: vi.fn() }));
vi.mock('../../db/index.js', () => ({ schema, getDb: () => ({
  transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback({
    select: () => ({ from: () => ({ where: () => ({ for: mocks.locked }) }) }), insert: mocks.insert,
  }),
}) }));
import { publishHistoryAdjustment } from './marketDataRepository.js';

beforeEach(() => vi.resetAllMocks());
describe('adjustment publication concurrency', () => {
  it.each([{ rows: [{ factorVersion: 'new-audit-version' }] }, { rows: [] }])('refuses stale or missing publications before any mutation: %j', async ({ rows }) => {
    mocks.locked.mockResolvedValue(rows);
    await expect(publishHistoryAdjustment({ instrumentKey: 46, expectedFactorVersion: 'old-version',
      factorVersion: 'live-version', sourceBatchId: 'batch', sourceRoot: 'provider:tencent',
      sourceFingerprint: 'fingerprint', sourceKey: 2, checkedDate: '2026-09-22',
      factors: [{ effectiveDate: '2026-07-10', factor: 1, offset: 0 }], priorTransform: { factor: 1, offset: 0 },
    })).rejects.toThrow('ADJUSTMENT_PUBLICATION_CHANGED');
    expect(mocks.locked).toHaveBeenCalledWith('update');
    expect(mocks.insert).not.toHaveBeenCalled();
  });
});
