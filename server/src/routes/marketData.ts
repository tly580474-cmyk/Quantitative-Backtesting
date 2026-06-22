import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ErrorCodes, apiError, dbUnavailable } from '../validation/errors.js';
import {
  getDailyCandles, getDataFreshness,
} from '../marketData/repositories/marketDataRepository.js';
import { listProviders } from '../marketData/providers/providerRegistry.js';
import { getInstrument } from '../marketData/repositories/instrumentRepository.js';

const candlesQuerySchema = z.object({
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(10000).default(500),
});

export function registerMarketDataRoutes(app: FastifyInstance, dbOnline: boolean): void {
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
      return reply.send(result);
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
