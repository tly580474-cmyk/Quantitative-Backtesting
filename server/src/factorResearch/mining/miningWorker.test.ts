import { describe, expect, it } from 'vitest';
import { buildWorkerConfig } from './miningWorker.js';

describe('mining worker config', () => {
  it('forces the published snapshot, isolated output and disables legacy persistence', () => {
    const config = buildWorkerConfig({
      data: { source: 'mysql', password: 'legacy' }, evolution: { seed: 7 },
      persistence: { enabled: true },
    }, { snapshotRoot: '/snapshots', outputRoot: '/tasks/1/output', totalGenerations: 12 });
    expect(config.data).toMatchObject({ source: 'snapshot', snapshot_root: '/snapshots' });
    expect(config.evolution).toMatchObject({ seed: 7, generations: 12 });
    expect(config.report).toMatchObject({ out_dir: '/tasks/1/output' });
    expect(config.persistence).toMatchObject({ enabled: false });
    expect((config.primitives as { functions: string[] }).functions).toContain('cs_neutralize');
    expect((config.primitives as { functions: string[] }).functions).not.toContain('ts_rank');
  });
});
