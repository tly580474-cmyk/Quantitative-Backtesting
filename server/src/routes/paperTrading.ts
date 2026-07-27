import type { FastifyInstance } from 'fastify';
import type mysql from 'mysql2/promise';
import { z } from 'zod';
import { dbUnavailable } from '../validation/errors.js';
import {
  PaperTradingError,
  cancelPaperOrder,
  createPaperAccount,
  getPaperAccount,
  listPaperAccounts,
  matchPaperOrder,
  submitPaperOrder,
} from '../paperTrading/service.js';

const accountBodySchema = z.object({
  name: z.string().trim().min(1).max(128),
  initialCash: z.number().finite().positive().max(1_000_000_000_000),
  commissionRate: z.number().finite().min(0).max(0.1).optional(),
  minimumCommission: z.number().finite().min(0).max(10_000).optional(),
  sellTaxRate: z.number().finite().min(0).max(0.1).optional(),
  slippageBps: z.number().finite().min(0).max(1_000).optional(),
});

const orderBodySchema = z.object({
  accountId: z.string().uuid(),
  clientOrderId: z.string().trim().min(1).max(64),
  securityCode: z.string().trim().regex(/^(?:SH|SZ|BJ)?\d{6}$/i),
  side: z.enum(['buy', 'sell']),
  orderType: z.enum(['market', 'limit']),
  quantity: z.number().finite().positive(),
  limitPrice: z.number().finite().positive().nullable().optional(),
}).superRefine((value, context) => {
  if (value.orderType === 'limit' && value.limitPrice == null) {
    context.addIssue({
      code: 'custom',
      path: ['limitPrice'],
      message: '限价委托必须提供委托价格',
    });
  }
});

export function registerPaperTradingRoutes(
  app: FastifyInstance,
  options: {
    dbOnline: boolean;
    pool: mysql.Pool;
    minuteDataRoot: string;
  },
): void {
  if (!options.dbOnline) {
    const stub = async () => {
      throw { statusCode: 503, ...dbUnavailable() };
    };
    app.get('/api/paper-trading/accounts', stub);
    app.get('/api/paper-trading/accounts/:id', stub);
    app.post('/api/paper-trading/accounts', stub);
    app.post('/api/paper-trading/orders', stub);
    app.post('/api/paper-trading/orders/:id/cancel', stub);
    app.post('/api/paper-trading/orders/:id/match', stub);
    return;
  }

  app.get('/api/paper-trading/accounts', async (_request, reply) =>
    handle(reply, () => listPaperAccounts(options.pool)));

  app.get<{ Params: { id: string } }>(
    '/api/paper-trading/accounts/:id',
    async (request, reply) =>
      handle(reply, () => getPaperAccount(options.pool, request.params.id)),
  );

  app.post('/api/paper-trading/accounts', async (request, reply) => {
    const parsed = accountBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'VALIDATION_ERROR',
        message: '模拟账户参数无效',
        details: parsed.error.issues,
      });
    }
    return handle(
      reply,
      () => createPaperAccount(options.pool, parsed.data),
      201,
    );
  });

  app.post('/api/paper-trading/orders', async (request, reply) => {
    const parsed = orderBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'VALIDATION_ERROR',
        message: '模拟委托参数无效',
        details: parsed.error.issues,
      });
    }
    return handle(
      reply,
      () => submitPaperOrder(options.pool, options.minuteDataRoot, parsed.data),
      201,
    );
  });

  app.post<{ Params: { id: string }; Body: { accountId?: string } }>(
    '/api/paper-trading/orders/:id/cancel',
    async (request, reply) => {
      const parsed = z.object({ accountId: z.string().uuid() }).safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'VALIDATION_ERROR',
          message: '撤单参数无效',
          details: parsed.error.issues,
        });
      }
      return handle(
        reply,
        () => cancelPaperOrder(options.pool, parsed.data.accountId, request.params.id),
      );
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/paper-trading/orders/:id/match',
    async (request, reply) =>
      handle(
        reply,
        () => matchPaperOrder(options.pool, options.minuteDataRoot, request.params.id),
      ),
  );
}

async function handle(
  reply: {
    status: (code: number) => unknown;
    code: (code: number) => { send: (payload: unknown) => unknown };
    send: (payload: unknown) => unknown;
  },
  action: () => Promise<unknown>,
  successStatus = 200,
) {
  try {
    const result = await action();
    return successStatus === 200
      ? reply.send(result)
      : reply.code(successStatus).send(result);
  } catch (error) {
    if (error instanceof PaperTradingError) {
      return reply.code(error.statusCode).send({
        error: error.code,
        message: error.message,
        details: error.details,
      });
    }
    throw error;
  }
}
