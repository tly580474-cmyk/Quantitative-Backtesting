// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, URL } from 'node:url';
import { validateDuckdbArguments } from './duckdbCliArguments.js';

describe('strict research CLI arguments', () => {
  it.each([
    ['query', []], ['query', ['SELECT 1']], ['schema', ['bars']],
    ['query', ['--sqi', 'SELECT 1']], ['query', ['--sql']],
    ['query', ['--sql', '--format', 'json']], ['query', ['--sql', ' ']],
    ['query', ['--sql', 'SELECT 1', '--file', 'query.sql']],
    ['query', ['--sql', 'SELECT 1', '-q', 'SELECT 2']],
    ['preview', ['--sql', 'SELECT 1']], ['pipeline', []],
  ] as Array<[string, string[]]>)('rejects %s %j instead of executing a fallback', (command, args) => {
    expect(() => validateDuckdbArguments(command, args)).toThrow('INVALID_ARGUMENT');
  });
  it('allows typed parameters and repeated research filters', () => {
    expect(() => validateDuckdbArguments('query', ['--sql', 'SELECT $n', '--param', 'n=-1', '-f', 'json'])).not.toThrow();
    expect(() => validateDuckdbArguments('recipe', ['--factor', 'a', '--factor', 'b', '--weight', 'a=-1'])).not.toThrow();
    expect(() => validateDuckdbArguments('preview', ['--view', 'bars'])).not.toThrow();
  });
  it('rejects an actual CLI invocation before opening a nonexistent snapshot or database', async () => {
    await expect(promisify(execFile)(process.execPath, ['--import', 'tsx',
      fileURLToPath(new URL('./duckdbCli.ts', import.meta.url)), 'query', 'SELECT 1',
      '--snapshot-root', 'does-not-exist'], { cwd: fileURLToPath(new URL('../../', import.meta.url)) }))
      .rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('INVALID_ARGUMENT') });
  });
});
