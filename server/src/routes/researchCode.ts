import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  runResearchCode,
  type ResearchCodeRuntimeOptions,
} from '../researchCode/researchSandboxClient.js';
import {
  createResearchCodeRun,
  getResearchCodeRun,
  listResearchCodeRuns,
  updateResearchCodeRunResult,
} from '../researchCode/researchCodeRepository.js';
import { apiError, dbUnavailable, ErrorCodes } from '../validation/errors.js';

// 阶段 C：受控开放"写代码研究"通道。
// 用户提交 Python 研究代码 → 强隔离沙箱执行（只读 MySQL + 只读 Parquet 挂载），
// 结果持久化并恒标记 authority=exploration_only / publishable=false（ADR-05）。

export interface ResearchCodeRouteOptions {
  runtime: ResearchCodeRuntimeOptions;
}

const submitResearchCodeSchema = z.object({
  code: z.string().min(1, '研究代码不能为空'),
  humanApprovalId: z.string().min(1).optional(),
  input: z.unknown().optional(),
});

function validationError(reply: FastifyReply, issues: unknown) {
  return reply.status(400).send(apiError(
    ErrorCodes.VALIDATION_ERROR,
    '研究代码请求未通过校验',
    issues,
  ));
}

export function registerResearchCodeRoutes(
  app: FastifyInstance,
  dbOnline: boolean,
  options: ResearchCodeRouteOptions,
): void {
  if (!dbOnline) {
    const stub = async () => { throw { statusCode: 503, ...dbUnavailable() }; };
    app.post('/api/research-code/runs', stub);
    app.get('/api/research-code/runs', stub);
    app.get('/api/research-code/runs/:id', stub);
    return;
  }

  app.post('/api/research-code/runs', async (req, reply) => {
    const parsed = submitResearchCodeSchema.safeParse(req.body ?? {});
    if (!parsed.success) return validationError(reply, parsed.error.issues);
    if (!options.runtime.enabled) {
      return reply.status(503).send(apiError(
        ErrorCodes.RESEARCH_CODE_DISABLED,
        '研究代码沙箱未启用（EXPERIMENT_RESEARCH_CODE_ENABLED=false）',
      ));
    }
    const code = parsed.data.code;
    const codeHash = createHash('sha256').update(code).digest('hex');
    const humanApprovalId = parsed.data.humanApprovalId ?? `user-${Date.now().toString(36)}`;
    const record = await createResearchCodeRun({
      request: {
        protocolVersion: '1.0',
        code,
        humanApprovalId,
        input: parsed.data.input,
      },
      codeHash,
      maxSeconds: options.runtime.maxSeconds,
    });

    try {
      const response = await runResearchCode({
        request: {
          protocolVersion: '1.0',
          code,
          humanApprovalId,
          input: parsed.data.input,
        },
        options: options.runtime,
      });
      await updateResearchCodeRunResult({
        id: record.id,
        status: response.status,
        result: response.result,
        resultHash: response.resultHash,
        capturedOutput: response.capturedOutput,
        error: response.error,
      });
      const updated = await getResearchCodeRun(record.id);
      return reply.status(201).send({ run: updated });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === 'RESEARCH_CODE_DISABLED') {
        return reply.status(503).send(apiError(
          ErrorCodes.RESEARCH_CODE_DISABLED,
          '研究代码沙箱未启用（EXPERIMENT_RESEARCH_CODE_ENABLED=false）',
        ));
      }
      await updateResearchCodeRunResult({
        id: record.id,
        status: 'failed',
        result: null,
        resultHash: null,
        capturedOutput: null,
        error: { type: 'client', message: message.slice(0, 500) },
      });
      const updated = await getResearchCodeRun(record.id);
      return reply.status(502).send({ run: updated, error: apiError(
        ErrorCodes.RESEARCH_CODE_RUN_FAILED,
        '研究代码执行失败（沙箱客户端错误）',
        { message: message.slice(0, 500) },
      ) });
    }
  });

  app.get<{ Querystring: { limit?: string } }>('/api/research-code/runs', async (req, reply) => {
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit ?? '50', 10) || 50, 1), 200);
    return reply.send({ runs: await listResearchCodeRuns(limit) });
  });

  app.get<{ Params: { id: string } }>('/api/research-code/runs/:id', async (req, reply) => {
    const run = await getResearchCodeRun(req.params.id);
    if (!run) {
      return reply.status(404).send(apiError(ErrorCodes.RESEARCH_CODE_RUN_NOT_FOUND, '研究代码运行不存在'));
    }
    return reply.send({ run });
  });
}
