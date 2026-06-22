import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ErrorCodes, apiError, dbUnavailable } from '../validation/errors.js';
import {
  listInstruments, getInstrument, createInstrument,
} from '../marketData/repositories/instrumentRepository.js';
import type { Market, InstrumentType } from '../marketData/types.js';
import { getInstrumentDataSummaries } from '../marketData/repositories/marketDataRepository.js';
import { getOpenQualitySeverities } from '../marketData/repositories/dataQualityRepository.js';

const listQuerySchema = z.object({
  market: z.string().optional(),
  symbol: z.string().optional(),
  search: z.string().optional(),
  type: z.string().optional(),
  status: z.string().optional(),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(50),
});

const createBodySchema = z.object({
  market: z.string().min(1),
  symbol: z.string().min(1),
  name: z.string().min(1),
  type: z.string().min(1),
  listDate: z.string().optional(),
  delistDate: z.string().optional(),
});

export function registerInstrumentRoutes(app: FastifyInstance, dbOnline: boolean): void {
  if (!dbOnline) {
    const stub = async () => { throw { statusCode: 503, ...dbUnavailable() }; };
    app.get('/api/instruments', stub);
    app.get('/api/instruments/:id', stub);
    app.post('/api/instruments', stub);
    return;
  }

  // GET /api/instruments — List with filtering and pagination
  app.get('/api/instruments', async (req, reply) => {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.status(400).send(
        apiError(ErrorCodes.VALIDATION_ERROR, '参数校验失败', parsed.error.issues),
      );
    }

    const { market, symbol, search, type, status, offset, limit } = parsed.data;

    const filters: Record<string, string> = {};
    if (market) filters.market = market;
    if (symbol) filters.symbol = symbol;
    if (search) filters.search = search;
    if (type) filters.type = type;
    if (status) filters.status = status;

    const result = await listInstruments({ ...filters, offset, limit });
    const ids = result.data.map((instrument) => instrument.id);
    const [summaries, severities] = await Promise.all([
      getInstrumentDataSummaries(ids),
      getOpenQualitySeverities(ids),
    ]);
    const summaryById = new Map(summaries.map((summary) => [summary.instrumentId, summary]));
    const severityById = new Map<string, 'warning' | 'blocked'>();
    for (const issue of severities) {
      const current = severityById.get(issue.instrumentId);
      if (issue.severity === 'blocked' || !current) {
        severityById.set(issue.instrumentId, issue.severity as 'warning' | 'blocked');
      }
    }
    const items = result.data.map((instrument) => {
      const summary = summaryById.get(instrument.id);
      return {
        ...instrument,
        startDate: summary?.startDate,
        endDate: summary?.endDate,
        qualityStatus: summary
          ? (severityById.get(instrument.id) ?? 'pass')
          : undefined,
      };
    });
    return reply.send({ items, total: result.total });
  });

  // GET /api/instruments/:id — Single instrument
  app.get<{ Params: { id: string } }>('/api/instruments/:id', async (req, reply) => {
    const inst = await getInstrument(req.params.id);
    if (!inst) {
      return reply.status(404).send(
        apiError(ErrorCodes.INSTRUMENT_NOT_FOUND, '交易标的不存在'),
      );
    }
    return reply.send(inst);
  });

  // POST /api/instruments — Create instrument
  app.post<{ Body: z.infer<typeof createBodySchema> }>(
    '/api/instruments',
    async (req, reply) => {
      const parsed = createBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send(
          apiError(ErrorCodes.VALIDATION_ERROR, '参数校验失败', parsed.error.issues),
        );
      }

      const now = new Date().toISOString();
      const instrument = {
        id: crypto.randomUUID(),
        ...parsed.data,
        market: parsed.data.market as Market,
        type: parsed.data.type as InstrumentType,
        status: 'active' as const,
        createdAt: now,
        updatedAt: now,
      };
      await createInstrument(instrument);
      return reply.status(201).send(instrument);
    },
  );
}
