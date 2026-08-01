import { describe, expect, it } from 'vitest';
import { selectPointInTimeIndustry, type IndustryMembershipVersion } from './pointInTimeIndustry.js';

const versions: IndustryMembershipVersion[] = [
  {
    instrumentKey: '000001.SZ', taxonomy: 'SW2021', level1Code: '801780', level1Name: '银行',
    effectiveFrom: '2024-01-01', effectiveTo: '2026-06-30', sourceVersion: 'sw-2024',
    fetchedAt: '2024-01-02T00:00:00Z',
  },
  {
    instrumentKey: '000001.SZ', taxonomy: 'SW2021', level1Code: '801790', level1Name: '非银金融',
    effectiveFrom: '2026-07-01', effectiveTo: null, sourceVersion: 'sw-2026',
    fetchedAt: '2026-07-02T00:00:00Z',
  },
];

describe('point-in-time industry membership', () => {
  it('does not let a future classification rewrite a historical decision', () => {
    expect(selectPointInTimeIndustry(versions, '000001.SZ', '2026-06-30')?.level1Code).toBe('801780');
    expect(selectPointInTimeIndustry(versions, '000001.SZ', '2026-07-01')?.level1Code).toBe('801790');
  });

  it('returns missing when no membership was effective at the decision date', () => {
    expect(selectPointInTimeIndustry(versions, '000001.SZ', '2023-12-31')).toBeNull();
  });
});
