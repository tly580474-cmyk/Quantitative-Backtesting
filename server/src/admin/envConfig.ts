import { copyFile, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface AdminConfigDefinition {
  key: string;
  label: string;
  category: 'access' | 'database' | 'ai' | 'market' | 'runtime';
  description: string;
  secret: boolean;
  editable: boolean;
  restartRequired: boolean;
}

export const ADMIN_CONFIG_DEFINITIONS: AdminConfigDefinition[] = [
  {
    key: 'ADMIN_API_TOKEN',
    label: '管理台访问令牌',
    category: 'access',
    description: '保护全部管理 API。为避免当前会话失效，只允许在 server/.env 中手动修改。',
    secret: true,
    editable: false,
    restartRequired: true,
  },
  {
    key: 'DB_HOST',
    label: 'MySQL 地址',
    category: 'database',
    description: 'MySQL 服务主机名或 IP 地址。',
    secret: false,
    editable: true,
    restartRequired: true,
  },
  {
    key: 'DB_PORT',
    label: 'MySQL 端口',
    category: 'database',
    description: 'MySQL 服务监听端口。',
    secret: false,
    editable: true,
    restartRequired: true,
  },
  {
    key: 'DB_USER',
    label: 'MySQL 用户',
    category: 'database',
    description: '业务数据库连接用户。',
    secret: false,
    editable: true,
    restartRequired: true,
  },
  {
    key: 'DB_PASSWORD',
    label: 'MySQL 密码',
    category: 'database',
    description: '业务数据库连接密码。',
    secret: true,
    editable: true,
    restartRequired: true,
  },
  {
    key: 'DB_NAME',
    label: 'MySQL 数据库',
    category: 'database',
    description: '量化平台使用的数据库名称。',
    secret: false,
    editable: true,
    restartRequired: true,
  },
  {
    key: 'AI_STRATEGY_ENABLED',
    label: 'AI 功能开关',
    category: 'ai',
    description: '控制策略生成、研究解读等大模型能力。',
    secret: false,
    editable: true,
    restartRequired: true,
  },
  {
    key: 'OPENAI_API_KEY',
    label: '大模型 API Key',
    category: 'ai',
    description: 'OpenAI 或兼容服务的访问密钥。',
    secret: true,
    editable: true,
    restartRequired: true,
  },
  {
    key: 'OPENAI_BASE_URL',
    label: '大模型 API 地址',
    category: 'ai',
    description: 'OpenAI Chat Completions 兼容服务地址。',
    secret: false,
    editable: true,
    restartRequired: true,
  },
  {
    key: 'OPENAI_MODEL',
    label: '大模型名称',
    category: 'ai',
    description: '策略生成和研究解读使用的模型。',
    secret: false,
    editable: true,
    restartRequired: true,
  },
  {
    key: 'MARKET_DATA_API_KEY',
    label: '行情源 API Key',
    category: 'market',
    description: '需要鉴权的扩展行情数据源密钥。',
    secret: true,
    editable: true,
    restartRequired: true,
  },
  {
    key: 'TUSHARE_TOKEN',
    label: 'Tushare Token',
    category: 'market',
    description: '历史分钟数据备用更新器访问令牌。',
    secret: true,
    editable: true,
    restartRequired: true,
  },
  {
    key: 'DUCKDB_MAX_CONCURRENT',
    label: 'DuckDB 并发上限',
    category: 'runtime',
    description: '同时运行的 DuckDB 重型研究会话数量。',
    secret: false,
    editable: true,
    restartRequired: true,
  },
  {
    key: 'DUCKDB_MAX_TEMP_SIZE',
    label: 'DuckDB 临时空间上限',
    category: 'runtime',
    description: '单机 DuckDB 临时目录允许使用的最大空间。',
    secret: false,
    editable: true,
    restartRequired: true,
  },
];

const editableKeys = new Set(
  ADMIN_CONFIG_DEFINITIONS.filter((item) => item.editable).map((item) => item.key),
);

export function maskConfigValue(value: string, secret: boolean): string | null {
  if (!value) return null;
  if (!secret) return value;
  const suffix = value.slice(-4);
  return `••••${suffix}`;
}

export function listAdminConfig(values: NodeJS.ProcessEnv = process.env) {
  return ADMIN_CONFIG_DEFINITIONS.map((definition) => {
    const value = values[definition.key]?.trim() ?? '';
    return {
      ...definition,
      configured: value.length > 0,
      maskedValue: maskConfigValue(value, definition.secret),
    };
  });
}

export async function updateEnvFile(
  envFilePath: string | URL,
  updates: Record<string, string>,
): Promise<string[]> {
  const entries = Object.entries(updates);
  if (entries.length === 0) throw new Error('没有需要更新的配置');
  for (const [key] of entries) {
    if (!editableKeys.has(key)) throw new Error(`配置项 ${key} 不允许通过管理台修改`);
    validateEnvValue(key, updates[key]);
  }

  const path = resolve(envFilePath instanceof URL ? fileURLToPath(envFilePath) : envFilePath);
  let source = '';
  try {
    source = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const pending = new Map(entries);
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=/);
    const key = match?.[1];
    if (!key || !pending.has(key)) {
      lines.push(line);
      continue;
    }
    if (seen.has(key)) continue;
    lines.push(`${key}=${serializeEnvValue(pending.get(key) ?? '')}`);
    seen.add(key);
  }
  for (const [key, value] of pending) {
    if (!seen.has(key)) lines.push(`${key}=${serializeEnvValue(value)}`);
  }

  const content = `${lines.join('\n').replace(/\n+$/, '')}\n`;
  const temporary = resolve(dirname(path), `.${Date.now()}-${process.pid}.env.tmp`);
  await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 });
  try {
    await copyFile(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }

  for (const [key, value] of entries) process.env[key] = value;
  return entries.map(([key]) => key);
}

function serializeEnvValue(value: string): string {
  if (value === '') return '';
  if (/^[A-Za-z0-9_./:@+-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function validateEnvValue(key: string, value: string): void {
  if (['DB_HOST', 'DB_USER', 'DB_NAME', 'OPENAI_MODEL'].includes(key) && !value.trim()) {
    throw new Error(`${key} 不能为空`);
  }
  if (key === 'DB_PORT') {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('DB_PORT 必须是 1 到 65535 的整数');
    }
  }
  if (key === 'AI_STRATEGY_ENABLED' && !['true', 'false'].includes(value)) {
    throw new Error('AI_STRATEGY_ENABLED 只能是 true 或 false');
  }
  if (key === 'DUCKDB_MAX_CONCURRENT') {
    const concurrency = Number(value);
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) {
      throw new Error('DUCKDB_MAX_CONCURRENT 必须是 1 到 8 的整数');
    }
  }
  if (key === 'DUCKDB_MAX_TEMP_SIZE' && !/^\d+(?:\.\d+)?(?:KB|MB|GB|TB)$/i.test(value)) {
    throw new Error('DUCKDB_MAX_TEMP_SIZE 必须使用容量格式，例如 50GB');
  }
  if (key === 'OPENAI_BASE_URL' && value) {
    try {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
    } catch {
      throw new Error('OPENAI_BASE_URL 必须是有效的 HTTP 或 HTTPS 地址');
    }
  }
}
