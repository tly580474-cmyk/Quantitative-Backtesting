import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ErrorCodes, apiError, dbUnavailable } from '../validation/errors.js';
import { getInstrument, listInstruments } from '../marketData/repositories/instrumentRepository.js';
import {
  listQualityIssues, updateQualityIssue, createQualityIssue, deleteQualityIssuesByInstrument,
} from '../marketData/repositories/dataQualityRepository.js';
import { getDailyCandles } from '../marketData/repositories/marketDataRepository.js';

// ─── Zod Schemas ───────────────────────────────────────────────────────

const listIssuesQuerySchema = z.object({
  status: z.string().optional(),
  severity: z.string().optional(),
  instrumentId: z.string().optional(),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(50),
});

const resolveBodySchema = z.object({
  resolution: z.enum(['confirmed', 'ignored', 'resolved']),
});

const recheckBodySchema = z.object({
  instrumentId: z.string().min(1).optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
});

// ─── Quality Check Rules ───────────────────────────────────────────────

const QUALITY_RULES: {
  code: string;
  severity: 'warning' | 'blocked';
  check: (candle: Record<string, unknown>) => string | null;
}[] = [
  {
    code: 'OHLC_NON_POSITIVE',
    severity: 'blocked',
    check: (c) =>
      Number(c.open) <= 0 || Number(c.high) <= 0 || Number(c.low) <= 0 || Number(c.close) <= 0
        ? 'OHLC 数据包含非正数值'
        : null,
  },
  {
    code: 'HIGH_LOW_INVALID',
    severity: 'blocked',
    check: (c) =>
      Number(c.high) < Number(c.low)
        ? `最高价(${c.high})低于最低价(${c.low})`
        : null,
  },
  {
    code: 'OPEN_CLOSE_RANGE',
    severity: 'warning',
    check: (c) => {
      const open = Number(c.open);
      const high = Number(c.high);
      const low = Number(c.low);
      const close = Number(c.close);
      if (open < low || open > high) {
        return `开盘价(${open})不在 [最低价(${low}), 最高价(${high})] 区间内`;
      }
      if (close < low || close > high) {
        return `收盘价(${close})不在 [最低价(${low}), 最高价(${high})] 区间内`;
      }
      return null;
    },
  },
  {
    code: 'VOLUME_NEGATIVE',
    severity: 'warning',
    check: (c) =>
      Number(c.volume) < 0
        ? `成交量(${c.volume})为负数`
        : null,
  },
  {
    code: 'ZERO_VOLUME',
    severity: 'warning',
    check: (c) =>
      Number(c.volume) === 0
        ? '成交量为零（可能停牌）'
        : null,
  },
];

// ─── Route Registration ─────────────────────────────────────────────────

export function registerDataQualityRoutes(app: FastifyInstance, dbOnline: boolean): void {
  if (!dbOnline) {
    const stub = async () => { throw { statusCode: 503, ...dbUnavailable() }; };
    app.get('/api/data-quality/issues', stub);
    app.post('/api/data-quality/issues/:id/resolve', stub);
    app.post('/api/data-quality/recheck', stub);
    return;
  }

  // GET /api/data-quality/issues — List quality issues with pagination
  app.get('/api/data-quality/issues', async (req, reply) => {
    const parsed = listIssuesQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.status(400).send(
        apiError(ErrorCodes.VALIDATION_ERROR, '参数校验失败', parsed.error.issues),
      );
    }

    const { status, severity, instrumentId, offset, limit } = parsed.data;
    const filters: Record<string, string> = {};
    if (status) filters.status = status;
    if (severity) filters.severity = severity;
    if (instrumentId) filters.instrumentId = instrumentId;

    const result = await listQualityIssues({ ...filters, offset, limit });
    return reply.send({ items: result.data, total: result.total });
  });

  // POST /api/data-quality/issues/:id/resolve — Update issue resolution
  app.post<{ Params: { id: string }; Body: z.infer<typeof resolveBodySchema> }>(
    '/api/data-quality/issues/:id/resolve',
    async (req, reply) => {
      const parsed = resolveBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send(
          apiError(ErrorCodes.VALIDATION_ERROR, '参数校验失败', parsed.error.issues),
        );
      }

      const { resolution } = parsed.data;

      const updates: Record<string, unknown> = {
        status: resolution,
      };
      if (resolution === 'resolved') {
        updates.resolvedAt = new Date().toISOString();
      }

      await updateQualityIssue(req.params.id, updates);
      return reply.send({ id: req.params.id, ...updates });
    },
  );

  // POST /api/data-quality/recheck — Re-run quality checks for an instrument
  app.post<{ Body: z.infer<typeof recheckBodySchema> }>(
    '/api/data-quality/recheck',
    async (req, reply) => {
      const parsed = recheckBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send(
          apiError(ErrorCodes.VALIDATION_ERROR, '参数校验失败', parsed.error.issues),
        );
      }

      const { instrumentId, startDate, endDate } = parsed.data;

      const now = new Date().toISOString();
      let newIssues = 0;
      let totalChecked = 0;
      const targets = instrumentId
        ? [await getInstrument(instrumentId)].filter((item) => item != null)
        : (await listInstruments({ offset: 0, limit: 100000 })).data;
      if (instrumentId && targets.length === 0) {
        return reply.status(404).send(
          apiError(ErrorCodes.INSTRUMENT_NOT_FOUND, '交易标的不存在'),
        );
      }

      for (const instrument of targets) {
        const candleResult = await getDailyCandles(instrument.id, {
          startDate, endDate, offset: 0, limit: 10000,
        });
        const candles = candleResult.data as unknown as Record<string, unknown>[];
        totalChecked += candles.length;
        await deleteQualityIssuesByInstrument(instrument.id);

        for (const candle of candles) {
          for (const rule of QUALITY_RULES) {
            const detail = rule.check(candle);
            if (!detail) continue;
            await createQualityIssue({
              id: crypto.randomUUID(), instrumentId: instrument.id,
              tradeDate: (candle.tradeDate as string) || '',
              ruleCode: rule.code, severity: rule.severity, status: 'open',
              details: { message: detail }, detectedAt: now,
            });
            newIssues++;
          }
        }
      }

      return reply.send({ newIssues, totalChecked, instrumentsChecked: targets.length });
    },
  );
}
