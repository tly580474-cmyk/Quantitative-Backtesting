import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeTextOutputAtomic } from './researchOutput.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('research output finalization', () => {
  it('keeps an existing output and writes a timestamped sibling', async () => {
    const root = await mkdtemp(join(tmpdir(), 'research-output-'));
    roots.push(root);
    const requested = join(root, 'result.csv');
    const first = await writeTextOutputAtomic(requested, 'a\n1\n');
    const second = await writeTextOutputAtomic(requested, 'a\n2\n');

    expect(first).toBe(requested);
    expect(second).not.toBe(requested);
    expect(await readFile(first, 'utf8')).toBe('a\n1\n');
    expect(await readFile(second, 'utf8')).toBe('a\n2\n');
    expect((await readdir(root)).some((name) => name.endsWith('.partial'))).toBe(false);
  });
});
