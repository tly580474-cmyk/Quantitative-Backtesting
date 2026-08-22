import { describe, expect, it } from 'vitest';
import { buildCodexEnvironment, CodexAgentProvider } from './codexAgentProvider.js';

describe('CodexAgentProvider safety boundary', () => {
  it('stays unavailable while disabled without affecting Claude startup', () => {
    const provider = new CodexAgentProvider({
      enabled: false,
      codexPath: 'codex',
      workingDirectory: 'D:/missing-workspace',
      codexHome: 'D:/missing-home',
      apiKey: '',
    });
    expect(provider.health()).toMatchObject({
      id: 'codex', enabled: false, available: false, reason: 'Codex Provider 未启用',
    });
  });

  it('advertises only MVP capabilities', () => {
    const provider = new CodexAgentProvider({
      enabled: false, codexPath: 'codex', workingDirectory: '', codexHome: '', apiKey: '',
    });
    expect(provider.capabilities).toEqual({
      streaming: true, resume: true, cancel: true, approvals: false,
      sandbox: true, skills: false, mcp: false,
    });
  });

  it('advertises interactive approvals only when explicitly enabled', () => {
    const provider = new CodexAgentProvider({
      enabled: false, codexPath: 'codex', workingDirectory: '', codexHome: '', apiKey: '', approvalsEnabled: true,
    });
    expect(provider.capabilities.approvals).toBe(true);
  });

  it('advertises the isolated external-data skill only when enabled', () => {
    const provider = new CodexAgentProvider({
      enabled: false, codexPath: 'codex', workingDirectory: '', codexHome: '', apiKey: '',
      externalDataSkillEnabled: true,
    });
    expect(provider.capabilities.skills).toBe(true);
  });

  it('requires a project API key instead of falling back to global Codex login', () => {
    const provider = new CodexAgentProvider({
      enabled: true,
      codexPath: process.execPath,
      workingDirectory: process.cwd(),
      codexHome: process.cwd(),
      apiKey: '   ',
    });
    expect(provider.health()).toMatchObject({
      id: 'codex', enabled: true, available: false, reason: 'Codex API key 未配置',
    });
  });

  it('does not inherit backend or market credentials', () => {
    const env = buildCodexEnvironment({
      SystemRoot: 'C:/Windows', PATH: 'safe-path', DB_PASSWORD: 'db-secret',
      SMTP_PASSWORD: 'smtp-secret', OPENAI_API_KEY: 'api-secret', TUSHARE_TOKEN: 'market-secret',
      AGENT_CODEX_API_KEY: 'project-codex-secret',
    }, 'C:/codex-home');
    expect(env).toMatchObject({ SystemRoot: 'C:/Windows', PATH: 'safe-path', CODEX_HOME: 'C:/codex-home' });
    expect(env).not.toHaveProperty('DB_PASSWORD');
    expect(env).not.toHaveProperty('SMTP_PASSWORD');
    expect(env).not.toHaveProperty('OPENAI_API_KEY');
    expect(env).not.toHaveProperty('TUSHARE_TOKEN');
    expect(env).not.toHaveProperty('AGENT_CODEX_API_KEY');
    expect(env).not.toHaveProperty('CODEX_PROVIDER_API_KEY');
  });

  it('passes only the dedicated custom-provider key to App Server', () => {
    const env = buildCodexEnvironment({ PATH: 'safe-path', OPENAI_API_KEY: 'global-secret' }, 'C:/codex-home', 'temporary-key');
    expect(env.CODEX_PROVIDER_API_KEY).toBe('temporary-key');
    expect(env).not.toHaveProperty('OPENAI_API_KEY');
  });

  it('prepends only the isolated skill virtualenv to PATH', () => {
    const pythonPath = process.platform === 'win32'
      ? 'C:\\codex-home\\venv\\Scripts\\python.exe'
      : '/codex-home/venv/bin/python';
    const env = buildCodexEnvironment({ PATH: 'safe-path' }, 'C:/codex-home', undefined, pythonPath);
    expect(env.PATH).toContain('venv');
    expect(env.PATH).toContain('safe-path');
  });
});
