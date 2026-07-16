import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { listAdminConfig, maskConfigValue, updateEnvFile } from './envConfig.js';

const roots: string[] = [];
const originalModel = process.env.OPENAI_MODEL;
const originalKey = process.env.OPENAI_API_KEY;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  if (originalModel === undefined) delete process.env.OPENAI_MODEL;
  else process.env.OPENAI_MODEL = originalModel;
  if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalKey;
});

describe('admin env config', () => {
  it('never exposes a full secret', () => {
    expect(maskConfigValue('sk-example-12345678', true)).toBe('••••5678');
    expect(maskConfigValue('', true)).toBeNull();
    const item = listAdminConfig({ OPENAI_API_KEY: 'sk-secret-value' }).find(
      (entry) => entry.key === 'OPENAI_API_KEY',
    );
    expect(item?.maskedValue).toBe('••••alue');
    expect(JSON.stringify(item)).not.toContain('sk-secret-value');
  });

  it('updates allowlisted values while preserving comments', async () => {
    const root = await mkdtemp(join(tmpdir(), 'admin-env-'));
    roots.push(root);
    const path = join(root, '.env');
    await writeFile(path, '# comment\nOPENAI_MODEL=old\nDB_HOST=127.0.0.1\n', 'utf8');
    await updateEnvFile(path, {
      OPENAI_MODEL: 'new model',
      OPENAI_API_KEY: 'secret#value',
    });
    const content = await readFile(path, 'utf8');
    expect(content).toContain('# comment');
    expect(content).toContain('OPENAI_MODEL="new model"');
    expect(content).toContain('OPENAI_API_KEY="secret#value"');
  });

  it('rejects non-allowlisted keys', async () => {
    const root = await mkdtemp(join(tmpdir(), 'admin-env-'));
    roots.push(root);
    await expect(updateEnvFile(join(root, '.env'), {
      NODE_OPTIONS: '--inspect',
    })).rejects.toThrow('不允许');
  });

  it('rejects invalid constrained values', async () => {
    const root = await mkdtemp(join(tmpdir(), 'admin-env-'));
    roots.push(root);
    await expect(updateEnvFile(join(root, '.env'), {
      DB_PORT: '70000',
    })).rejects.toThrow('65535');
    await expect(updateEnvFile(join(root, '.env'), {
      AI_STRATEGY_ENABLED: 'yes',
    })).rejects.toThrow('true 或 false');
  });
});
