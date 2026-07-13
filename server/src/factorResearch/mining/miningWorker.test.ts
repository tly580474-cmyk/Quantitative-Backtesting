import { describe, expect, it } from 'vitest';
import { buildWorkerConfig, isWorkerCommandForTask } from './miningWorker.js';

describe('mining worker config', () => {
  it('forces the published snapshot, isolated output and disables legacy persistence', () => {
    const config = buildWorkerConfig({
      data: { source: 'mysql', password: 'legacy' }, evolution: { seed: 7 },
      persistence: { enabled: true },
    }, { snapshotRoot: '/snapshots', outputRoot: '/tasks/1/output', totalGenerations: 12 });
    expect(config.data).toMatchObject({ source: 'snapshot', snapshot_root: '/snapshots' });
    expect(config.evolution).toMatchObject({ seed: 7, generations: 12, checkpoint_freq: 1 });
    expect(config.report).toMatchObject({ out_dir: '/tasks/1/output' });
    expect(config.persistence).toMatchObject({ enabled: false });
    expect((config.primitives as { functions: string[] }).functions).toContain('cs_neutralize');
    expect((config.primitives as { functions: string[] }).functions).not.toContain('ts_rank');
  });

  it('matches only the expected task worker command', () => {
    const taskId = 'f622d26f-411c-4d5e-8ca7-f2b495a37db6';
    expect(isWorkerCommandForTask(
      `python worker_entry.py --config C:/tasks/${taskId}/config.json`, taskId)).toBe(true);
    expect(isWorkerCommandForTask('python worker_entry.py --config C:/tasks/other/config.json', taskId)).toBe(false);
    expect(isWorkerCommandForTask(`powershell query ${taskId}`, taskId)).toBe(false);
  });
});
