import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ErrorCodes, apiError, dbUnavailable } from '../validation/errors.js';
import {
  getDailyCandles, getDataFreshness,
} from '../marketData/repositories/marketDataRepository.js';
import { listProviders } from '../marketData/providers/providerRegistry.js';
import { getInstrument } from '../marketData/repositories/instrumentRepository.js';
import {
  fetchResearchReports,
  fetchCachedMarketSentimentOverview,
  fetchMarketTechnicalRows,
  fetchMarketIndexQuotes,
  fetchStockIntraday,
  fetchStockKline,
  fetchStockQuote,
  searchStocks,
} from '../marketData/aStockDataService.js';
import {
  analyzeHistoricalTechnicals,
  filterEnrichedCandidates,
  prefilterMarketTechnicalRows,
  type HistoricalTechnicalIndicators,
  type MarketTechnicalCandidate,
} from '../marketData/marketTechnicalScreen.js';
import { tencentProvider } from '../marketData/providers/tencentProvider.js';
import { updateIndexDatasets } from '../marketData/jobs/indexDatasetUpdater.js';
import { StockResearchAgent } from '../services/stockResearchAgent.js';
import { fetchSevenLayerSection, fetchSevenLayerSnapshot } from '../marketData/sevenLayerDataService.js';
import { fetchCachedHotSectors, fetchSectorConstituents } from '../marketData/hotSectorService.js';

const candlesQuerySchema = z.object({
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(10000).default(500),
});

const candidateIndicatorCache = new Map<string, { data: HistoricalTechnicalIndicators | null; cachedAt: number }>();
const CANDIDATE_INDICATOR_CACHE_MS = 30 * 60_000;

async function enrichTechnicalCandidates(
  candidates: MarketTechnicalCandidate[],
): Promise<MarketTechnicalCandidate[]> {
  const result = [...candidates];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(12, result.length) }, async () => {
    while (cursor < result.length) {
      const index = cursor++;
      const candidate = result[index];
      const cached = candidateIndicatorCache.get(candidate.code);
      if (cached && Date.now() - cached.cachedAt < CANDIDATE_INDICATOR_CACHE_MS) {
        result[index] = { ...candidate, indicators: cached.data };
        continue;
      }
      try {
        const indicators = analyzeHistoricalTechnicals(await fetchStockKline(candidate.code, 'day', 120));
        candidateIndicatorCache.set(candidate.code, { data: indicators, cachedAt: Date.now() });
        result[index] = { ...candidate, indicators };
      } catch {
        candidateIndicatorCache.set(candidate.code, { data: null, cachedAt: Date.now() });
        result[index] = { ...candidate, indicators: null };
      }
    }
  });
  await Promise.all(workers);
  return result;
}

interface ResearchAgentConfig {
  apiKey: string;
  baseURL: string;
  model: string;
  timeoutMs: number;
  availableModels: string[];
}

export function registerMarketDataRoutes(
  app: FastifyInstance,
  dbOnline: boolean,
  agentConfig: ResearchAgentConfig,
): void {
  const agent = new StockResearchAgent(
    agentConfig.apiKey,
    agentConfig.baseURL,
    agentConfig.model,
    agentConfig.timeoutMs,
  );

  // These endpoints fetch public market data on demand and intentionally do not depend on MySQL.
  app.get('/api/market-data/stocks/search', async (req, reply) => {
    const query = z.object({ q: z.string().trim().min(1).max(40) }).safeParse(req.query);
    if (!query.success) return reply.status(400).send({ message: '请输入股票代码、简称或拼音' });
    try {
      return reply.send({ items: await searchStocks(query.data.q) });
    } catch (error) {
      req.log.error(error);
      return reply.status(502).send({ message: '股票搜索暂时不可用，请稍后重试' });
    }
  });

  app.get<{ Params: { code: string } }>('/api/market-data/stocks/:code/quote', async (req, reply) => {
    try {
      return reply.send(await fetchStockQuote(req.params.code));
    } catch (error) {
      return reply.status(502).send({ message: error instanceof Error ? error.message : '行情获取失败' });
    }
  });

  app.get('/api/market-data/indices/quotes', async (_req, reply) => {
    try {
      return reply.send({ items: await fetchMarketIndexQuotes() });
    } catch (error) {
      return reply.status(502).send({ message: error instanceof Error ? error.message : '大盘行情获取失败' });
    }
  });

  app.get<{ Querystring: { force?: string } }>('/api/market-data/market-sentiment', async (req, reply) => {
    try {
      return reply.send(await fetchCachedMarketSentimentOverview(req.query.force === 'true'));
    } catch (error) {
      return reply.status(502).send({ message: error instanceof Error ? error.message : '市场情绪获取失败' });
    }
  });

  app.get<{ Querystring: { force?: string } }>('/api/market-data/hot-sectors', async (req, reply) => {
    try {
      return reply.send(await fetchCachedHotSectors(req.query.force === 'true'));
    } catch (error) {
      req.log.error(error);
      return reply.status(502).send({ message: error instanceof Error ? error.message : '热门板块获取失败' });
    }
  });

  app.get<{ Params: { code: string }; Querystring: { name?: string } }>(
    '/api/market-data/hot-sectors/:code/constituents',
    async (req, reply) => {
      const input = z.object({
        code: z.string().trim().regex(/^BK\d{4}$/i),
        name: z.string().trim().max(40).optional(),
      }).safeParse({ ...req.params, ...req.query });
      if (!input.success) return reply.status(400).send({ message: '板块代码格式不正确' });
      try {
        return reply.send(await fetchSectorConstituents(
          input.data.code.toUpperCase(),
          input.data.name ?? input.data.code.toUpperCase(),
        ));
      } catch (error) {
        req.log.error(error);
        return reply.status(502).send({ message: error instanceof Error ? error.message : '板块成分股获取失败' });
      }
    },
  );

  app.post('/api/market-data/technical-screen', async (req, reply) => {
    const body = z.object({
      markets: z.array(z.enum(['SH', 'SZ', 'BJ'])).min(1).default(['SH', 'SZ']),
      minChangePct: z.number().min(-30).max(30).default(0),
      maxChangePct: z.number().min(-30).max(30).default(7),
      minAmountYi: z.number().min(0).max(10000).default(1),
      minTurnoverPct: z.number().min(0).max(100).default(0),
      minVolumeRatio: z.number().min(0).max(20).default(0),
      maxAmplitudePct: z.number().min(0).max(100).default(15),
      excludeRiskNames: z.boolean().default(true),
      trend: z.enum(['any', 'bullish', 'aboveMa20', 'bearish']).default('any'),
      returnPeriod: z.union([z.literal(5), z.literal(10), z.literal(20)]).default(20),
      minPeriodReturn: z.number().min(-100).max(1000).default(-30),
      maxPeriodReturn: z.number().min(-100).max(1000).default(30),
      streakDirection: z.enum(['any', 'up', 'down']).default('any'),
      minStreakDays: z.number().int().min(1).max(20).default(2),
      minRsi: z.number().min(0).max(100).default(0),
      maxRsi: z.number().min(0).max(100).default(100),
      kdjSignal: z.enum(['any', 'golden', 'death']).default('any'),
      macdSignal: z.enum(['any', 'golden', 'death']).default('any'),
      limit: z.number().int().min(1).max(200).default(50),
      force: z.boolean().optional(),
    }).safeParse(req.body ?? {});
    if (!body.success
      || body.data.minChangePct > body.data.maxChangePct
      || body.data.minPeriodReturn > body.data.maxPeriodReturn
      || body.data.minRsi > body.data.maxRsi) {
      return reply.status(400).send({ message: '技术筛选条件无效，请检查范围上下限' });
    }
    try {
      const { force, ...criteria } = body.data;
      const rows = await fetchMarketTechnicalRows(force);
      const poolLimit = Math.min(160, Math.max(criteria.limit * 3, 80));
      const prefiltered = prefilterMarketTechnicalRows(rows, criteria, poolLimit);
      const enriched = await enrichTechnicalCandidates(prefiltered);
      const items = filterEnrichedCandidates(enriched, criteria);
      return reply.send({
        items,
        totalScanned: rows.length,
        totalEnriched: enriched.filter((item) => item.indicators != null).length,
        updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      req.log.error(error);
      return reply.status(502).send({ message: error instanceof Error ? error.message : '市场技术筛选失败' });
    }
  });

  app.get<{ Params: { code: string } }>('/api/market-data/stocks/:code/kline', async (req, reply) => {
    const query = z.object({ period: z.enum(['intraday', 'day', 'week', 'year']).default('day') }).safeParse(req.query);
    if (!query.success) return reply.status(400).send({ message: '不支持的 K 线周期' });
    try {
      const items = query.data.period === 'intraday'
        ? await fetchStockIntraday(req.params.code)
        : await fetchStockKline(req.params.code, query.data.period);
      return reply.send({ period: query.data.period, items });
    } catch (error) {
      return reply.status(502).send({ message: error instanceof Error ? error.message : 'K 线获取失败' });
    }
  });

  app.get<{ Params: { code: string } }>('/api/market-data/stocks/:code/reports', async (req, reply) => {
    try {
      return reply.send({ items: await fetchResearchReports(req.params.code) });
    } catch (error) {
      return reply.status(502).send({ message: error instanceof Error ? error.message : '研报获取失败' });
    }
  });

  app.get<{ Params: { code: string } }>('/api/market-data/stocks/:code/seven-layer', async (req, reply) => {
    try {
      return reply.send(await fetchSevenLayerSnapshot(req.params.code));
    } catch (error) {
      req.log.error(error);
      return reply.status(502).send({ message: error instanceof Error ? error.message : '七层数据源获取失败' });
    }
  });

  app.get<{ Params: { code: string; section: string } }>('/api/market-data/stocks/:code/seven-layer/:section', async (req, reply) => {
    const section = z.enum(['signal', 'capital', 'fundamental', 'announcement']).safeParse(req.params.section);
    if (!section.success) return reply.status(400).send({ message: '不支持的数据源模块' });
    try {
      return reply.send(await fetchSevenLayerSection(req.params.code, section.data));
    } catch (error) {
      req.log.error(error);
      return reply.status(502).send({ message: error instanceof Error ? error.message : '数据源模块获取失败' });
    }
  });

  app.get('/api/market-data/research-agent/status', async (_req, reply) => reply.send({
    configured: Boolean(agentConfig.apiKey),
    currentModel: agentConfig.model,
    availableModels: agentConfig.availableModels,
    workflow: ['实时行情', '日K/周K趋势', '机构研报', '证据整理', '风险核验'],
  }));

  app.post<{ Params: { code: string } }>('/api/market-data/stocks/:code/research', async (req, reply) => {
    const body = z.object({ question: z.string().max(1000).optional(), model: z.string().optional() }).safeParse(req.body ?? {});
    if (!body.success) return reply.status(400).send({ message: '调研参数无效' });
    if (body.data.model && !agentConfig.availableModels.includes(body.data.model)) {
      return reply.status(400).send({ message: '请求的模型不在允许列表中' });
    }
    if (!agentConfig.apiKey) return reply.status(503).send({ message: '请先在服务端配置 AI 模型与密钥' });
    try {
      const [quote, daily, weekly, reports] = await Promise.all([
        fetchStockQuote(req.params.code),
        fetchStockKline(req.params.code, 'day'),
        fetchStockKline(req.params.code, 'week'),
        fetchResearchReports(req.params.code, 12),
      ]);
      return reply.send(await agent.research({ quote, daily, weekly, reports, question: body.data.question }, body.data.model));
    } catch (error) {
      req.log.error(error);
      return reply.status(502).send({ message: error instanceof Error ? error.message : 'Agent 调研失败' });
    }
  });

  if (!dbOnline) {
    const stub = async () => { throw { statusCode: 503, ...dbUnavailable() }; };
    app.get('/api/instruments/:id/candles', stub);
    app.get('/api/market-data/freshness', stub);
    app.get('/api/market-data/providers', stub);
    app.post('/api/market-data/index-datasets/update', stub);
    return;
  }

  app.post('/api/market-data/index-datasets/update', async (req, reply) => {
    const body = z.object({
      group: z.enum(['cn-index', 'us-index']),
      force: z.boolean().optional(),
    }).safeParse(req.body ?? {});
    if (!body.success) return reply.status(400).send({ message: '请指定 group: cn-index 或 us-index' });
    try {
      return reply.send(await updateIndexDatasets(body.data.group, tencentProvider, new Date(), { force: body.data.force }));
    } catch (error) {
      req.log.error(error);
      return reply.status(502).send({ message: error instanceof Error ? error.message : '指数数据集更新失败' });
    }
  });

  // GET /api/instruments/:id/candles — Daily candles for synced data
  app.get<{ Params: { id: string } }>(
    '/api/instruments/:id/candles',
    async (req, reply) => {
      const inst = await getInstrument(req.params.id);
      if (!inst) {
        return reply.status(404).send(
          apiError(ErrorCodes.INSTRUMENT_NOT_FOUND, '交易标的不存在'),
        );
      }

      const parsed = candlesQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return reply.status(400).send(
          apiError(ErrorCodes.VALIDATION_ERROR, '参数校验失败', parsed.error.issues),
        );
      }

      const { startDate, endDate, offset, limit } = parsed.data;
      const result = await getDailyCandles(req.params.id, {
        startDate,
        endDate,
        offset,
        limit,
      });
      return reply.send({ items: result.data, total: result.total });
    },
  );

  // GET /api/market-data/freshness — Overall data freshness summary
  app.get('/api/market-data/freshness', async (_req, reply) => {
    const freshness = await getDataFreshness();
    return reply.send(freshness);
  });

  // GET /api/market-data/providers — Available data provider IDs and capabilities
  app.get('/api/market-data/providers', async (_req, reply) => {
    const providers = listProviders();
    const data = providers.map((p) => ({
      id: p.id,
      name: p.name,
      type: p.type,
      capabilities: p.getCapabilities(),
    }));
    return reply.send(data);
  });
}
