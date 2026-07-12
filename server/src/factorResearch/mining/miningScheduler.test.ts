import { describe, expect, it } from 'vitest';
import { rollScheduledSplit, shouldLaunchForSnapshot } from './miningScheduler.js';

describe('snapshot mining schedule', () => {
  it('does not reopen the same published snapshot', () => {
    expect(shouldLaunchForSnapshot('snapshot-v1', 'snapshot-v1')).toBe(false);
    expect(shouldLaunchForSnapshot('snapshot-v1', 'snapshot-v2')).toBe(true);
  });
  it('rolls the next locked-test start beyond the prior test interval', () => {
    const config = rollScheduledSplit({ data: { sample_symbols: 500 } }, '2026-06-30');
    expect(config.data).toMatchObject({ train_end: '2024-06-30', valid_end: '2026-06-30' });
  });
});
