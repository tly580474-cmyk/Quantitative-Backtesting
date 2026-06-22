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

  PORT: z.string().default('3001'),
});

export type EnvConfig = z.infer<typeof envSchema>;

export function loadConfig(): EnvConfig {
  return envSchema.parse(process.env);
}
