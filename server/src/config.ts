import { z } from 'zod';

const envSchema = z.object({
  // Database
  DB_HOST: z.string().default('127.0.0.1'),
  DB_PORT: z.string().default('3306'),
  DB_USER: z.string().default('root'),
  DB_PASSWORD: z.string().default(''),
  DB_NAME: z.string().default('quant_backtest'),

  // AI Strategy
  AI_STRATEGY_ENABLED: z.enum(['true', 'false']).default('false'),
  OPENAI_API_KEY: z.string().default(''),
  OPENAI_BASE_URL: z.string().default('https://api.openai.com/v1'),
  OPENAI_MODEL: z.string().default('deepseek-v4-flash'),
  OPENAI_TIMEOUT_MS: z.string().default('60000'),

  // Market Data
  MARKET_DATA_ENABLED: z.enum(['true', 'false']).default('false'),
  MARKET_DATA_PROVIDER: z.string().default('tencent'),
  MARKET_DATA_API_KEY: z.string().default(''),
  MARKET_DATA_BASE_URL: z.string().default(''),
  MARKET_DATA_SYNC_TIME: z.string().default('15:30'),
  MARKET_DATA_INTRADAY_INTERVAL_MINUTES: z.string().default('30'),
  MARKET_INDEX_AUTO_UPDATE_ENABLED: z.enum(['true', 'false']).default('true'),
  MARKET_CN_INDEX_UPDATE_TIME: z.string().default('15:05'),
  MARKET_US_INDEX_UPDATE_TIME: z.string().default('05:00'),
  DRAGON_TIGER_ENABLED: z.enum(['true', 'false']).default('true'),
  DRAGON_TIGER_SYNC_TIME: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default('18:00'),
  DRAGON_TIGER_RECHECK_TIME: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default('18:30'),
  MARKET_NEWS_ENABLED: z.enum(['true', 'false']).default('true'),
  MARKET_NEWS_REFRESH_INTERVAL_MINUTES: z.string().regex(/^\d+$/).default('3'),
  MARKET_NEWS_RETENTION_DAYS: z.string().regex(/^\d+$/).default('30'),
  HISTORY_STORE_READ_MODE: z.enum(['legacy', 'prefer-v2', 'v2']).default('prefer-v2'),
  HISTORY_STORE_DUAL_WRITE: z.enum(['true', 'false']).default('true'),
  RESEARCH_SNAPSHOT_ROOT: z.string().default('./data/research-snapshots'),
  RESEARCH_QUERY_MAX_ROWS: z.string().default('10000'),
  MINUTE_DATA_ZIP_ROOT: z.string().default('../../所有股票的历史数据/1m_price_zip'),
  MINUTE_DATA_ROOT: z.string().default('../../所有股票的历史数据/1m_price_parquet'),
  MINUTE_QUERY_MAX_ROWS: z.string().default('100000'),
  BACKUP_ROOT: z.string().default('./data/backups'),
  FACTOR_RESEARCH_ROOT: z.string().default('./data/factor-research'),
  FACTOR_MINER_PYTHON: z.string().default('python'),
  FACTOR_MINER_ROOT: z.string().default('../tools/factor-miner'),
  // 系统级硬上限；单个任务仍可在界面设置更短的超时。
  FACTOR_MINER_TIMEOUT_MS: z.string().default('21600000'),
  FACTOR_MINER_MAX_MEMORY_MB: z.string().default('4096'),

  // Operations admin console. Empty means the admin API is disabled.
  ADMIN_API_TOKEN: z.string().default(''),
  // Overview TTL cache (ms). 0 disables caching. See ADMIN_CONSOLE_OPTIMIZATION_PLAN §1.
  ADMIN_OVERVIEW_CACHE_TTL_MS: z.string().default('10000'),

  PORT: z.string().default('3001'),
});

export type EnvConfig = z.infer<typeof envSchema>;

export function loadConfig(): EnvConfig {
  return envSchema.parse(process.env);
}
