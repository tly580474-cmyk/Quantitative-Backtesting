import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  defaultArtifactManifestPath,
  writeResearchArtifactManifest,
} from './researchArtifactManifest.js';

describe('research artifact manifest', () => {
  it('records SQL, output files, snapshot and minute provenance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'artifact-manifest-'));
    const minuteRoot = join(root, 'minute');
    const outputRoot = join(root, 'out');
    await mkdir(minuteRoot);
    await mkdir(outputRoot);
    await writeFile(join(minuteRoot, 'manifest.json'), JSON.stringify({
      preparedAt: '2026-07-16T00:00:00Z',
      firstDate: '2026-01-01',
      lastDate: '2026-07-16',
      tradingDays: 100,
    }));
    const output = join(outputRoot, 'result.csv');
    await writeFile(output, 'a\n1\n');
    const manifestPath = join(outputRoot, 'run.manifest.json');
    await writeResearchArtifactManifest(manifestPath, {
      command: 'pipeline',
      name: 'test',
      sourcePath: join(root, 'pipeline.json'),
      status: 'validated',
      startedAt: '2026-07-16T00:00:00Z',
      completedAt: '2026-07-16T00:00:01Z',
      snapshot: {
        snapshotId: 'snapshot-1',
        sourceVersion: 'source-1',
        sourcePublishedAt: '2026-07-16T00:00:00Z',
      },
      minuteRoot,
      parameters: { startDate: '2026-01-01' },
      queries: [{ id: 'query', sql: 'SELECT 1' }],
      outputs: [{ id: 'query', path: output, format: 'csv', rows: 1 }],
    });
    const value = JSON.parse(await readFile(manifestPath, 'utf8'));
    expect(value.status).toBe('validated');
    expect(value.snapshot.snapshotId).toBe('snapshot-1');
    expect(value.minute.lastDate).toBe('2026-07-16');
    expect(value.queries[0].sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(value.outputs[0].files[0].sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('uses a safe deterministic default filename', () => {
    expect(defaultArtifactManifestPath('D:/out', 'D:/pipelines/run.json', 'A/B'))
      .toMatch(/A_B\.manifest\.json$/);
  });
});
