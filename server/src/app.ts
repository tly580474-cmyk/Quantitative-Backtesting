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
import { registerExportRoutes } from './routes/export.js';
import { registerInstrumentRoutes } from './routes/instruments.js';
import { registerMarketDataRoutes } from './routes/marketData.js';
import { registerSyncJobRoutes } from './routes/syncJobs.js';
import { registerDataQualityRoutes } from './routes/dataQuality.js';
import { registerFactorResearchRoutes } from './routes/factorResearch.js';
import { registerAdminRoutes } from './routes/admin.js';
import { MockStrategyGenerationProvider } from './services/strategyGeneration/mockProvider.js';
import { OpenAIStrategyGenerationProvider } from './services/strategyGeneration/openaiProvider.js';
import type { StrategyGenerationProvider } from './services/strategyGeneration/provider.js';
import { registerProvider } from './marketData/providers/providerRegistry.js';
import { primaryProvider } from './marketData/providers/primaryProvider.js';
import { tencentProvider } from './marketData/providers/tencentProvider.js';
import { startScheduler } from './marketData/jobs/syncScheduler.js';
import { startIndexDatasetScheduler } from './marketData/jobs/indexDatasetScheduler.js';
import { startDragonTigerScheduler } from './marketData/jobs/dragonTigerScheduler.js';
import { startMarketNewsScheduler } from './marketData/jobs/marketNewsScheduler.js';
import { startMarketOpinionPushScheduler } from './marketData/jobs/marketOpinionPushScheduler.js';
import { EmailSender } from './services/emailSender.js';
import { MarketOpinionAgent } from './services/marketOpinionAgent.js';
import { MarketOpinionPushService } from './services/marketOpinionPushService.js';
import { configureHistoryStorePolicy } from './marketData/repositories/historyStorePolicy.js';
import { recoverInterruptedCandidateTests } from './factorResearch/candidates/candidateRepository.js';
import { getDuckDBRuntimeStats } from './research/duckdbRuntime.js';

async function main(): Promise<void> {
  let requestedExitCode = 0;
  const config = loadConfig();
  configureHistoryStorePolicy({
    readMode: config.HISTORY_STORE_READ_MODE,
    dualWrite: config.HISTORY_STORE_DUAL_WRITE === 'true',
  });

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
  const availableAiModels = [...new Set([
    config.OPENAI_MODEL,
    'deepseek-v4-flash',
    'deepseek-v4-pro',
  ])];
  const opinionPushTimes = {
    morning: config.MARKET_OPINION_MORNING_TIME,
    midday: config.MARKET_OPINION_MIDDAY_TIME,
    close: config.MARKET_OPINION_CLOSE_TIME,
  } as const;
  const opinionRecipients = config.MAIL_TO.split(',').map((item) => item.trim()).filter(Boolean);
  const opinionEmailSender = new EmailSender({
    host: config.SMTP_HOST,
    port: parseInt(config.SMTP_PORT, 10),
    secure: config.SMTP_SECURE === 'true',
    user: config.SMTP_USER,
    password: config.SMTP_PASSWORD,
    from: config.MAIL_FROM || config.SMTP_USER,
    to: opinionRecipients,
  });
  const opinionPushService = new MarketOpinionPushService({
    enabled: config.MARKET_OPINION_PUSH_ENABLED === 'true',
    schedules: opinionPushTimes,
    recipientCount: opinionRecipients.length,
    agent: new MarketOpinionAgent(
      aiConfigured ? config.OPENAI_API_KEY : '',
      config.OPENAI_BASE_URL,
      config.OPENAI_MODEL,
      parseInt(config.OPENAI_TIMEOUT_MS, 10),
    ),
    email: opinionEmailSender,
    model: config.OPENAI_MODEL,
  });

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
    const recoveredTests = await recoverInterruptedCandidateTests();
    if (recoveredTests > 0) {
      console.warn(`[FactorResearch] Recovered ${recoveredTests} interrupted locked test(s).`);
    }
  }

  // ── Fastify App ─────────────────────────────────────────────
  const app = Fastify({ logger: true, bodyLimit: 104857600 });

  await app.register(cors, {
    origin: /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  // Health check (reports DB status)
  app.get('/api/health', async () => ({
    status: 'ok',
    db: dbStatus.ok ? 'connected' : 'disconnected',
    duckdb: getDuckDBRuntimeStats(),
  }));

  // Register AI routes
  registerAiRoutes(
    app,
    provider,
    aiEnabled,
    aiConfigured,
    config.OPENAI_MODEL,
    availableAiModels,
  );

  // Register data routes
  const dbOnline = dbStatus.ok;
  registerDatasetRoutes(app, dbOnline);
  registerStrategyConfigRoutes(app, dbOnline);
  registerResultRoutes(app, dbOnline);
  registerVisualStrategyRoutes(app, dbOnline);
  registerExportRoutes(app, dbOnline);

  // Phase 5: Market data platform
  if (dbOnline) {
    const providers = [tencentProvider, primaryProvider]
      .sort((a, b) => Number(b.id === config.MARKET_DATA_PROVIDER) - Number(a.id === config.MARKET_DATA_PROVIDER));
    for (const marketProvider of providers) {
      registerProvider(marketProvider);
      console.log(`[MarketData] Registered provider: ${marketProvider.id}`);
    }

    if (config.MARKET_DATA_ENABLED === 'true' && config.MARKET_DATA_SYNC_TIME) {
      startScheduler({
        enabled: true,
        dailySyncTime: config.MARKET_DATA_SYNC_TIME,
        markets: ['SH', 'SZ', 'BJ'],
        providerId: providers[0].id,
        intradayIntervalMinutes: Math.max(
          1,
          parseInt(config.MARKET_DATA_INTRADAY_INTERVAL_MINUTES, 10) || 30,
        ),
      });
      console.log(`[MarketData] Scheduler started, daily sync at ${config.MARKET_DATA_SYNC_TIME}`);
    }

    if (config.MARKET_INDEX_AUTO_UPDATE_ENABLED === 'true') {
      startIndexDatasetScheduler({
        enabled: true,
        cnUpdateTime: config.MARKET_CN_INDEX_UPDATE_TIME,
        usUpdateTime: config.MARKET_US_INDEX_UPDATE_TIME,
      }, tencentProvider);
    }

    if (config.DRAGON_TIGER_ENABLED === 'true') {
      startDragonTigerScheduler({
        syncTime: config.DRAGON_TIGER_SYNC_TIME,
        recheckTime: config.DRAGON_TIGER_RECHECK_TIME,
      });
      console.log(`[DragonTiger] Collector started at ${config.DRAGON_TIGER_SYNC_TIME}/${config.DRAGON_TIGER_RECHECK_TIME}`);
    }
    if (config.MARKET_NEWS_ENABLED === 'true') {
      startMarketNewsScheduler({
        refreshIntervalMinutes: parseInt(config.MARKET_NEWS_REFRESH_INTERVAL_MINUTES, 10),
        retentionDays: parseInt(config.MARKET_NEWS_RETENTION_DAYS, 10),
      });
      console.log(`[MarketNews] Collector started every ${config.MARKET_NEWS_REFRESH_INTERVAL_MINUTES} minute(s)`);
    }
    if (config.MARKET_OPINION_PUSH_ENABLED === 'true') {
      if (!aiConfigured || !opinionEmailSender.isConfigured()) {
        console.warn('[MarketOpinionPush] Disabled: AI or SMTP configuration is incomplete.');
      } else {
        startMarketOpinionPushScheduler(opinionPushService, {
          times: opinionPushTimes,
          graceMinutes: Math.max(1, parseInt(config.MARKET_OPINION_PUSH_GRACE_MINUTES, 10) || 20),
          weekdaysOnly: config.MARKET_OPINION_PUSH_WEEKDAYS_ONLY === 'true',
        });
        console.log(`[MarketOpinionPush] Scheduler started at ${Object.values(opinionPushTimes).join('/')}`);
      }
    }
  }

  registerInstrumentRoutes(app, dbOnline, {
    historyReadMode: config.HISTORY_STORE_READ_MODE,
  });
  registerMarketDataRoutes(app, dbOnline, {
    apiKey: aiConfigured ? config.OPENAI_API_KEY : '',
    baseURL: config.OPENAI_BASE_URL,
    model: config.OPENAI_MODEL,
    timeoutMs: parseInt(config.OPENAI_TIMEOUT_MS, 10),
    availableModels: availableAiModels,
  }, {
    historyReadMode: config.HISTORY_STORE_READ_MODE,
    snapshotRoot: config.RESEARCH_SNAPSHOT_ROOT,
    minuteDataRoot: config.MINUTE_DATA_ROOT,
    minuteQueryMaxRows: Math.max(
      241,
      parseInt(config.MINUTE_QUERY_MAX_ROWS, 10) || 100000,
    ),
    researchQueryMaxRows: Math.max(
      1,
      parseInt(config.RESEARCH_QUERY_MAX_ROWS, 10) || 10000,
    ),
    pool,
    config,
  }, opinionPushService);
  registerSyncJobRoutes(app, dbOnline);
  registerDataQualityRoutes(app, dbOnline);
  registerAdminRoutes(app, {
    pool,
    dbOnline,
    config,
    envFilePath: new URL('../.env', import.meta.url),
    restart: {
      available: process.env.QUANT_BACKEND_SUPERVISED === 'true',
      request: () => {
        requestedExitCode = 75;
        process.kill(process.pid, 'SIGTERM');
      },
    },
  });
  registerFactorResearchRoutes(app, dbOnline, {
    snapshotRoot: config.RESEARCH_SNAPSHOT_ROOT,
    artifactRoot: config.FACTOR_RESEARCH_ROOT,
    pool,
    miningWorker: {
      pythonExecutable: config.FACTOR_MINER_PYTHON,
      minerRoot: config.FACTOR_MINER_ROOT,
      timeoutMs: Math.max(60_000, parseInt(config.FACTOR_MINER_TIMEOUT_MS, 10) || 21_600_000),
      maxMemoryMb: Math.max(256, parseInt(config.FACTOR_MINER_MAX_MEMORY_MB, 10) || 4096),
    },
    ai: {
      enabled: aiEnabled,
      configured: aiConfigured,
      apiKey: aiConfigured ? config.OPENAI_API_KEY : '',
      baseURL: config.OPENAI_BASE_URL,
      model: config.OPENAI_MODEL,
      timeoutMs: parseInt(config.OPENAI_TIMEOUT_MS, 10),
    },
  });
  if (dbOnline) {
    const { startMiningScheduler } = await import('./factorResearch/mining/miningScheduler.js');
    startMiningScheduler({
      pythonExecutable: config.FACTOR_MINER_PYTHON,
      minerRoot: config.FACTOR_MINER_ROOT,
      snapshotRoot: config.RESEARCH_SNAPSHOT_ROOT,
      artifactRoot: config.FACTOR_RESEARCH_ROOT,
      timeoutMs: Math.max(60_000, parseInt(config.FACTOR_MINER_TIMEOUT_MS, 10) || 21_600_000),
      maxMemoryMb: Math.max(256, parseInt(config.FACTOR_MINER_MAX_MEMORY_MB, 10) || 4096),
    });
  }

  // Graceful shutdown
  const shutdown = async () => {
    console.log('[Server] Shutting down...');
    const { stopScheduler } = await import('./marketData/jobs/syncScheduler.js');
    const { stopIndexDatasetScheduler } = await import('./marketData/jobs/indexDatasetScheduler.js');
    const { stopMiningScheduler } = await import('./factorResearch/mining/miningScheduler.js');
    const { stopDragonTigerScheduler } = await import('./marketData/jobs/dragonTigerScheduler.js');
    const { stopMarketNewsScheduler } = await import('./marketData/jobs/marketNewsScheduler.js');
    const { stopMarketOpinionPushScheduler } = await import('./marketData/jobs/marketOpinionPushScheduler.js');
    stopScheduler();
    stopIndexDatasetScheduler();
    stopMiningScheduler();
    stopDragonTigerScheduler();
    stopMarketNewsScheduler();
    stopMarketOpinionPushScheduler();
    await app.close();
    closeDb();
    await closePool(pool);
    console.log('[Server] Shutdown complete.');
    process.exit(requestedExitCode);
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
