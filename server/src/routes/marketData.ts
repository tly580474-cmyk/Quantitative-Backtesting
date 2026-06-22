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
  fetchStockKline,
  fetchStockQuote,
  searchStocks,
} from '../marketData/aStockDataService.js';
import { StockResearchAgent } from '../services/stockResearchAgent.js';

const candlesQuerySchema = z.object({
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(10000).default(500),
});

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

  app.get<{ Params: { code: string } }>('/api/market-data/stocks/:code/kline', async (req, reply) => {
    const query = z.object({ period: z.enum(['day', 'week', 'year']).default('day') }).safeParse(req.query);
    if (!query.success) return reply.status(400).send({ message: '不支持的 K 线周期' });
    try {
      return reply.send({ period: query.data.period, items: await fetchStockKline(req.params.code, query.data.period) });
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
    return;
  }

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
