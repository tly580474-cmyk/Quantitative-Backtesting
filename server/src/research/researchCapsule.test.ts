import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it, expect } from 'vitest';
import { saveCapsule, reuseCapsule } from './researchCapsule.js';
it('refuses stale, changed, overwritten or out-of-scope research artifacts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'capsule-'));
  const file = 'tmp_output/agent-runs/r1/data.json';
  try {
    const context = { argv: ['query', '--sql', 'select 1'], snapshotPointer: 's1', inputHashes: [] };
    await saveCapsule(root, file, { ok: true, usable: true }, context, 10_000);
    expect((await reuseCapsule(root, file, 's1', 11_000)).reusable).toBe(true);
    expect((await reuseCapsule(root, file, 's2', 11_000)).reasons).toContain('snapshot-changed');
    expect((await reuseCapsule(root, file, 's1', 50_000)).reasons).toContain('expired');
    await expect(saveCapsule(root, file, {}, context)).rejects.toThrow();
    await expect(saveCapsule(root, '../outside.json', {}, context)).rejects.toThrow('INVALID_ARGUMENT');
    await writeFile(join(root, file), '{"version":1,"sha256":"changed"}');
    expect((await reuseCapsule(root, file, 's1', 11_000)).reasons).toContain('integrity-mismatch');
  } finally { await rm(root, { recursive: true, force: true }); }
});
