import { describe, expect, it } from 'vitest';
import { buildClaudeEnvironment, ClaudeAgentProvider } from './claudeAgentProvider.js';

describe('ClaudeAgentProvider native Windows boundary', () => {
  it('uses a minimal host environment without backend credentials', () => {
    const env = buildClaudeEnvironment({
      SystemRoot: 'C:/Windows', PATH: 'safe-path', USERPROFILE: 'C:/Users/test',
      DB_PASSWORD: 'db-secret', ANTHROPIC_API_KEY: 'provider-secret', TUSHARE_TOKEN: 'market-secret',
    }, 'C:/Program Files/Git/bin/bash.exe');
    expect(env).toMatchObject({
      SystemRoot: 'C:/Windows', PATH: 'safe-path', USERPROFILE: 'C:/Users/test',
      CLAUDE_CODE_GIT_BASH_PATH: 'C:/Program Files/Git/bin/bash.exe',
    });
    expect(env).not.toHaveProperty('DB_PASSWORD');
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(env).not.toHaveProperty('TUSHARE_TOKEN');
  });

  it('accepts existing absolute native executable and workspace paths', () => {
    const provider = new ClaudeAgentProvider({
      workingDirectory: process.cwd(), claudePath: process.execPath,
    });
    expect(provider.health()).toMatchObject({ enabled: true, available: process.platform === 'win32' });
  });
});
