import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { loadConfig } from './config.js';
import { createPool, checkConnection, closePool } from './db/connection.js';
import { initDb, closeDb } from './db/index.js';
import { runMigrations } from './db/migrate.js';
import { registerAiRoutes } from './routes/aiStrategies.js';
import { registerDatasetRoutes } from './routes/datasets.js';
import { registerStrategyConfigRoutes } from './routes/strategyConfigs.js';
import { registerResultRoutes } from './routes/results.js';
import { registerVisualStrategyRoutes } from './routes/visualStrategies.js';
import { registerMigrationRoutes } from './routes/migration.js';
import { registerExportRoutes } from './routes/export.js';
import { MockStrategyGenerationProvider } from './services/strategyGeneration/mockProvider.js';
import { OpenAIStrategyGenerationProvider } from './services/strategyGeneration/openaiProvider.js';
import type { StrategyGenerationProvider } from './services/strategyGeneration/provider.js';

async function main(): Promise<void> {
  const config = loadConfig();

  // ── AI Provider ─────────────────────────────────────────────
  const aiEnabled = config.AI_STRATEGY_ENABLED === 'true';
  const aiConfigured = aiEnabled && config.OPENAI_API_KEY.length > 0;

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

  // ── MySQL Connection ────────────────────────────────────────
  console.log(`[DB] Connecting to MySQL at ${config.DB_HOST}:${config.DB_PORT}/${config.DB_NAME}...`);
  const pool = createPool(config);
  const dbStatus = await checkConnection(pool);

  if (!dbStatus.ok) {
    console.warn(`[DB] MySQL unavailable: ${dbStatus.error}`);
    console.warn('[DB] Server will start but data endpoints will return 503.');
  } else {
    console.log('[DB] MySQL connected.');
    initDb(pool);

    // Run migrations
    const { applied, errors } = await runMigrations(pool);
    if (applied.length > 0) {
      console.log(`[DB] Applied ${applied.length} migration(s): ${applied.join(', ')}`);
    }
    if (errors.length > 0) {
      console.error(`[DB] Migration errors: ${errors.join('; ')}`);
    }
  }

  // ── Fastify App ─────────────────────────────────────────────
  const app = Fastify({ logger: true, bodyLimit: 104857600 }); // 100MB for data migration

  await app.register(cors, {
    origin: ['http://localhost:5173', 'http://127.0.0.1:5173'],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type'],
  });

  // Health check (reports DB status)
  app.get('/api/health', async () => ({
    status: 'ok',
    db: dbStatus.ok ? 'connected' : 'disconnected',
  }));

  // Register AI routes
  registerAiRoutes(
    app,
    provider,
    aiEnabled,
    aiConfigured,
    config.OPENAI_MODEL,
    ['deepseek-v4-flash', 'deepseek-v4-pro'],
  );

  // Register data routes
  const dbOnline = dbStatus.ok;
  registerDatasetRoutes(app, dbOnline);
  registerStrategyConfigRoutes(app, dbOnline);
  registerResultRoutes(app, dbOnline);
  registerVisualStrategyRoutes(app, dbOnline);
  registerMigrationRoutes(app, dbOnline);
  registerExportRoutes(app, dbOnline);

  // Graceful shutdown
  const shutdown = async () => {
    console.log('[Server] Shutting down...');
    await app.close();
    closeDb();
    await closePool(pool);
    console.log('[Server] Shutdown complete.');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

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
