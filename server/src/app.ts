import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { loadConfig } from './config.js';
import { registerAiRoutes } from './routes/aiStrategies.js';
import { MockStrategyGenerationProvider } from './services/strategyGeneration/mockProvider.js';
import { OpenAIStrategyGenerationProvider } from './services/strategyGeneration/openaiProvider.js';
import type { StrategyGenerationProvider } from './services/strategyGeneration/provider.js';

async function main(): Promise<void> {
  const config = loadConfig();

  const aiEnabled = config.AI_STRATEGY_ENABLED === 'true';
  const aiConfigured = aiEnabled && config.OPENAI_API_KEY.length > 0;

  // Create the appropriate provider
  let provider: StrategyGenerationProvider;
  if (aiConfigured) {
    provider = new OpenAIStrategyGenerationProvider(
      config.OPENAI_API_KEY,
      config.OPENAI_BASE_URL,
      config.OPENAI_MODEL,
      parseInt(config.OPENAI_TIMEOUT_MS, 10),
    );
    console.log(`[AI] Provider configured (baseURL: ${config.OPENAI_BASE_URL}, model: ${config.OPENAI_MODEL})`);
  } else {
    provider = new MockStrategyGenerationProvider();
    console.log('[AI] Using mock provider (no API key configured)');
  }

  const app = Fastify({ logger: true });

  await app.register(cors, {
    origin: ['http://localhost:5173', 'http://127.0.0.1:5173'],
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type'],
  });

  // Register AI routes
  registerAiRoutes(
    app,
    provider,
    aiEnabled,
    aiConfigured,
    config.OPENAI_MODEL,
    ['deepseek-v4-flash', 'deepseek-v4-pro'],
  );

  // Health check
  app.get('/api/health', async () => ({ status: 'ok' }));

  const port = parseInt(config.PORT, 10);
  try {
    await app.listen({ port, host: '0.0.0.0' });
    console.log(`Server listening on http://localhost:${port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
