// @vitest-environment node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
const entry = fileURLToPath(new URL('../../scripts/researchData.mjs', import.meta.url));
const run = (...args: string[]) => promisify(execFile)(process.execPath, [entry, ...args], { cwd: fileURLToPath(new URL('../../../', import.meta.url)) });
describe('unified research CLI contract', () => {
  it('discovers fund flows without connecting to the database', async () => {
    const result = JSON.parse((await run('catalog', '--task', 'fund-flow')).stdout);
    expect(result.datasets).toHaveLength(1);
    expect(result.datasets[0].command).toContain('fund-flows');
  });
  it('reports unsupported index valuations without consulting service health', async () => {
    const result = JSON.parse((await run('describe', 'index_valuations')).stdout);
    expect(result).toMatchObject({ status: 'unsupported', available: false });
  });
  it.each([['query', 'SELECT 1'], ['query'], ['fund-flows', '--days', '0'], ['catalog', '--top', '1']])('propagates failure for %j', async (...args) => {
    try { await run(...args); throw new Error('unexpected success'); }
    catch (error: any) {
      expect(error.code).toBe(1);
      expect(JSON.parse(error.stdout)).toMatchObject({ ok: false, errorCategory: 'invalid_argument' });
    }
  });
});
