import type { FastifyInstance } from 'fastify';
import type mysql from 'mysql2/promise';
import { z } from 'zod';
import { dbUnavailable } from '../validation/errors.js';
import {
  PaperTradingError,
  cancelPaperOrder,
  createPaperAccount,
  deletePaperAccount,
  getPaperAccount,
  listPaperAccounts,
  matchPaperOrder,
  previewPaperOrder,
  submitPaperOrder,
} from '../paperTrading/service.js';
import {
  getPaperRiskConfig,
  upsertPaperRiskConfig,
} from '../paperTrading/riskControl.js';
import {
  getLatestPaperEquitySnapshot,
  listPaperEquitySnapshots,
  recordPaperEquitySnapshot,
} from '../paperTrading/equitySnapshot.js';
import { reconcilePaperAccount } from '../paperTrading/reconciliation.js';
import {
  createPaperStrategyBinding,
  deletePaperStrategyBinding,
  getPaperStrategyBinding,
  listPaperStrategyBindings,
  updatePaperStrategyBinding,
} from '../paperTrading/strategyBinding.js';
import { getChinaMarketSession } from '../marketData/jobs/marketSession.js';

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
  securityCode: z.string().trim().min(1).max(255),
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

const orderPreviewBodySchema = z.object({
  accountId: z.string().uuid(),
  securityQuery: z.string().trim().min(1).max(255),
  side: z.enum(['buy', 'sell']),
  orderType: z.enum(['market', 'limit']),
  limitPrice: z.number().finite().positive().nullable().optional(),
});

const riskConfigBodySchema = z.object({
  accountId: z.string().uuid(),
  maxSinglePositionRatio: z.number().finite().min(0).max(1).nullable().optional(),
  maxTotalPositionRatio: z.number().finite().min(0).max(1).nullable().optional(),
  maxOrderAmount: z.number().finite().positive().nullable().optional(),
  maxDailyTurnover: z.number().finite().positive().nullable().optional(),
  maxDailyOrders: z.number().int().positive().nullable().optional(),
  maxDrawdownRatio: z.number().finite().min(0).max(1).nullable().optional(),
  maxDailyLoss: z.number().finite().positive().nullable().optional(),
});

const bindingBodySchema = z.object({
  accountId: z.string().uuid(),
  strategyId: z.string().trim().min(1).max(128),
  strategyName: z.string().trim().min(1).max(255),
  params: z.record(z.string(), z.unknown()).optional(),
  status: z.enum(['paused', 'active', 'stopped', 'error']).optional(),
});

const bindingUpdateSchema = z.object({
  status: z.enum(['paused', 'active', 'stopped', 'error']).optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  strategyName: z.string().trim().min(1).max(255).optional(),
});

const snapshotBodySchema = z.object({
  benchmarkCode: z.string().trim().max(20).nullable().optional(),
  benchmarkClose: z.number().finite().positive().nullable().optional(),
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
    app.delete('/api/paper-trading/accounts/:id', stub);
    app.post('/api/paper-trading/orders/preview', stub);
    app.post('/api/paper-trading/orders', stub);
    app.post('/api/paper-trading/orders/:id/cancel', stub);
    app.post('/api/paper-trading/orders/:id/match', stub);
    app.get('/api/paper-trading/accounts/:id/risk-config', stub);
    app.put('/api/paper-trading/risk-configs', stub);
    app.get('/api/paper-trading/accounts/:id/snapshots', stub);
    app.get('/api/paper-trading/accounts/:id/snapshots/latest', stub);
    app.post('/api/paper-trading/accounts/:id/snapshots', stub);
    app.get('/api/paper-trading/accounts/:id/reconcile', stub);
    app.get('/api/paper-trading/bindings', stub);
    app.get('/api/paper-trading/accounts/:id/bindings', stub);
    app.post('/api/paper-trading/bindings', stub);
    app.get('/api/paper-trading/bindings/:id', stub);
    app.patch('/api/paper-trading/bindings/:id', stub);
    app.delete('/api/paper-trading/bindings/:id', stub);
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

  app.delete<{ Params: { id: string } }>(
    '/api/paper-trading/accounts/:id',
    async (request, reply) =>
      handle(reply, () => deletePaperAccount(options.pool, request.params.id)),
  );

  app.post('/api/paper-trading/orders/preview', async (request, reply) => {
    const parsed = orderPreviewBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'VALIDATION_ERROR',
        message: '委托预览参数无效',
        details: parsed.error.issues,
      });
    }
    return handle(
      reply,
      () => previewPaperOrder(options.pool, options.minuteDataRoot, parsed.data),
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

  // === 风控配置 ===
  app.get<{ Params: { id: string } }>(
    '/api/paper-trading/accounts/:id/risk-config',
    async (request, reply) =>
      handle(reply, async () => {
        const config = await getPaperRiskConfig(options.pool, request.params.id);
        return config ?? { accountId: request.params.id, limits: null };
      }),
  );

  app.put('/api/paper-trading/risk-configs', async (request, reply) => {
    const parsed = riskConfigBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'VALIDATION_ERROR',
        message: '风控参数无效',
        details: parsed.error.issues,
      });
    }
    return handle(reply, () => upsertPaperRiskConfig(options.pool, parsed.data));
  });

  // === 权益快照 ===
  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    '/api/paper-trading/accounts/:id/snapshots',
    async (request, reply) =>
      handle(reply, () => listPaperEquitySnapshots(options.pool, request.params.id, {
        limit: request.query.limit ? parseInt(request.query.limit, 10) : undefined,
      })),
  );

  app.get<{ Params: { id: string } }>(
    '/api/paper-trading/accounts/:id/snapshots/latest',
    async (request, reply) =>
      handle(reply, async () => {
        const snapshot = await getLatestPaperEquitySnapshot(options.pool, request.params.id);
        return snapshot ?? { accountId: request.params.id, snapshot: null };
      }),
  );

  app.post<{ Params: { id: string }; Body: { benchmarkCode?: string | null; benchmarkClose?: number | null } }>(
    '/api/paper-trading/accounts/:id/snapshots',
    async (request, reply) => {
      const parsed = snapshotBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'VALIDATION_ERROR',
          message: '权益快照参数无效',
          details: parsed.error.issues,
        });
      }
      const tradeDate = getChinaMarketSession().tradeDate;
      return handle(
        reply,
        () => recordPaperEquitySnapshot(options.pool, request.params.id, tradeDate, parsed.data),
      );
    },
  );

  // === 对账 ===
  app.get<{ Params: { id: string } }>(
    '/api/paper-trading/accounts/:id/reconcile',
    async (request, reply) =>
      handle(reply, () => reconcilePaperAccount(options.pool, request.params.id)),
  );

  // === 策略绑定 ===
  app.get<{ Querystring: { accountId?: string } }>(
    '/api/paper-trading/bindings',
    async (request, reply) =>
      handle(reply, () => listPaperStrategyBindings(options.pool, request.query.accountId)),
  );

  app.get<{ Params: { id: string } }>(
    '/api/paper-trading/accounts/:id/bindings',
    async (request, reply) =>
      handle(reply, () => listPaperStrategyBindings(options.pool, request.params.id)),
  );

  app.post('/api/paper-trading/bindings', async (request, reply) => {
    const parsed = bindingBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'VALIDATION_ERROR',
        message: '策略绑定参数无效',
        details: parsed.error.issues,
      });
    }
    return handle(
      reply,
      () => createPaperStrategyBinding(options.pool, parsed.data),
      201,
    );
  });

  app.get<{ Params: { id: string } }>(
    '/api/paper-trading/bindings/:id',
    async (request, reply) =>
      handle(reply, async () => {
        const binding = await getPaperStrategyBinding(options.pool, request.params.id);
        if (!binding) {
          throw new PaperTradingError('BINDING_NOT_FOUND', '策略绑定不存在', 404);
        }
        return binding;
      }),
  );

  app.patch<{ Params: { id: string } }>(
    '/api/paper-trading/bindings/:id',
    async (request, reply) => {
      const parsed = bindingUpdateSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'VALIDATION_ERROR',
          message: '策略绑定更新参数无效',
          details: parsed.error.issues,
        });
      }
      return handle(
        reply,
        () => updatePaperStrategyBinding(options.pool, request.params.id, parsed.data),
      );
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/paper-trading/bindings/:id',
    async (request, reply) =>
      handle(reply, () => deletePaperStrategyBinding(options.pool, request.params.id)),
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
