import { z } from 'zod';

const envSchema = z.object({
  AI_STRATEGY_ENABLED: z.enum(['true', 'false']).default('false'),
  OPENAI_API_KEY: z.string().default(''),
  OPENAI_BASE_URL: z.string().default('https://api.openai.com/v1'),
  OPENAI_MODEL: z.string().default('deepseek-v4-flash'),
  OPENAI_TIMEOUT_MS: z.string().default('60000'),
  PORT: z.string().default('3001'),
});

export type EnvConfig = z.infer<typeof envSchema>;

export function loadConfig(): EnvConfig {
  // dotenv populates process.env before this runs
  return envSchema.parse(process.env);
}
