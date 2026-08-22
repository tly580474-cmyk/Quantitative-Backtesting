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

  it('never serializes either the admin token or provider key in config output', () => {
    const adminToken = 'admin-console-secret-value';
    const providerKey = 'provider-secret-value';
    const serialized = JSON.stringify(listAdminConfig({
      ADMIN_API_TOKEN: adminToken,
      OPENAI_API_KEY: providerKey,
    }));

    expect(serialized).not.toContain(adminToken);
    expect(serialized).not.toContain(providerKey);
    expect(serialized).toContain('••••alue');
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
    await expect(updateEnvFile(join(root, '.env'), {
      SCHEDULE_SKIP_NON_TRADING_PERIODS: 'yes',
    })).rejects.toThrow('true 或 false');
    await expect(updateEnvFile(join(root, '.env'), {
      RESEARCH_SNAPSHOT_UPDATE_TIME: '25:00',
    })).rejects.toThrow('HH:mm');
  });

  it('exposes schedule values as editable time fields', () => {
    const items = listAdminConfig({
      INSTRUMENT_SYNC_TIME: '15:20',
      MARKET_DATA_SYNC_TIME: '15:30',
      MARKET_CN_INDEX_UPDATE_TIME: '20:00',
      MARKET_US_INDEX_UPDATE_TIME: '05:00',
      MARKET_OPINION_MORNING_TIME: '09:00',
      MARKET_OPINION_MIDDAY_TIME: '12:00',
      MARKET_OPINION_CLOSE_TIME: '16:00',
      RESEARCH_SNAPSHOT_UPDATE_TIME: '18:00',
      RESEARCH_SNAPSHOT_RETRY_TIME: '18:30',
      RESEARCH_SNAPSHOT_MORNING_RETRY_TIME: '08:30',
      MINUTE_DATA_UPDATE_TIME: '16:30',
      MINUTE_DATA_RETRY_TIME: '17:30',
      FUND_FLOW_UPDATE_TIME: '16:20',
      FUND_FLOW_RETRY_TIME: '17:20',
    });
    for (const key of [
      'INSTRUMENT_SYNC_TIME',
      'MARKET_DATA_SYNC_TIME',
      'MARKET_CN_INDEX_UPDATE_TIME',
      'MARKET_US_INDEX_UPDATE_TIME',
      'MARKET_OPINION_MORNING_TIME',
      'MARKET_OPINION_MIDDAY_TIME',
      'MARKET_OPINION_CLOSE_TIME',
      'RESEARCH_SNAPSHOT_UPDATE_TIME',
      'RESEARCH_SNAPSHOT_RETRY_TIME',
      'RESEARCH_SNAPSHOT_MORNING_RETRY_TIME',
      'MINUTE_DATA_UPDATE_TIME',
      'MINUTE_DATA_RETRY_TIME',
      'FUND_FLOW_UPDATE_TIME',
      'FUND_FLOW_RETRY_TIME',
    ]) {
      expect(items.find((item) => item.key === key)).toMatchObject({
        editable: true,
        inputType: 'time',
      });
    }
  });

  it('masks the Tinyshare authorization code in admin responses', () => {
    const item = listAdminConfig({ TINYSHARE_TOKEN: 'tiny-secret-code' }).find(
      (entry) => entry.key === 'TINYSHARE_TOKEN',
    );
    expect(item).toMatchObject({ editable: true, secret: true, maskedValue: '••••code' });
    expect(JSON.stringify(item)).not.toContain('tiny-secret-code');
  });

  it('exposes the instrument master refresh as an enabled boolean option by default', () => {
    const item = listAdminConfig({}).find(
      (entry) => entry.key === 'INSTRUMENT_SYNC_ENABLED',
    );
    expect(item).toMatchObject({
      editable: true,
      inputType: 'boolean',
      configured: true,
      maskedValue: 'true',
      restartRequired: true,
    });
  });

  it('exposes every AI switch as a boolean option instead of free text', () => {
    const items = listAdminConfig({});
    for (const key of ['AI_STRATEGY_ENABLED', 'MARKET_OPINION_PUSH_ENABLED']) {
      expect(items.find((item) => item.key === key)).toMatchObject({
        editable: true,
        inputType: 'boolean',
        configured: true,
        maskedValue: 'false',
      });
    }
  });

  it('exposes the non-trading-period policy as an enabled boolean option by default', () => {
    const item = listAdminConfig({}).find(
      (entry) => entry.key === 'SCHEDULE_SKIP_NON_TRADING_PERIODS',
    );
    expect(item).toMatchObject({
      editable: true,
      inputType: 'boolean',
      configured: true,
      maskedValue: 'true',
      restartRequired: false,
    });
  });
});
