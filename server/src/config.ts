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
  MARKET_DATA_SYNC_TIME: z.string().default('20:00'),
  MARKET_DATA_INTRADAY_INTERVAL_MINUTES: z.string().default('30'),
  MARKET_INDEX_AUTO_UPDATE_ENABLED: z.enum(['true', 'false']).default('true'),
  MARKET_CN_INDEX_UPDATE_TIME: z.string().default('15:05'),
  MARKET_US_INDEX_UPDATE_TIME: z.string().default('05:00'),
  HISTORY_STORE_READ_MODE: z.enum(['legacy', 'prefer-v2', 'v2']).default('prefer-v2'),
  HISTORY_STORE_DUAL_WRITE: z.enum(['true', 'false']).default('true'),
  RESEARCH_SNAPSHOT_ROOT: z.string().default('./data/research-snapshots'),
  RESEARCH_QUERY_MAX_ROWS: z.string().default('10000'),

  PORT: z.string().default('3001'),
});

export type EnvConfig = z.infer<typeof envSchema>;

export function loadConfig(): EnvConfig {
  return envSchema.parse(process.env);
}
