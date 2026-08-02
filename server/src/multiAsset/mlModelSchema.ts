import { z } from 'zod';

// N2.2：MLModelSpec 协议与版本化。
// 模型分数作为"虚拟因子"进入多因子协议（复用 E3 rankMultiFactor），
// 不做独立资金账本。模型类型白名单、特征清单、训练/验证切分、随机种子
// 全部版本化并进入计划 hash。

const dateSchema = z.iso.date();
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const instrumentKeySchema = z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9_.:-]+$/);

/** sklearn 白名单模型类型（N2.3 由 model_worker.py 实现）。 */
export const mlModelTypeSchema = z.enum(['ridge', 'random_forest', 'gradient_boosting']);

const ridgeHyperparamsSchema = z.strictObject({
  alpha: z.number().finite().positive().max(10_000).default(1),
});

const forestHyperparamsSchema = z.strictObject({
  nEstimators: z.number().int().min(10).max(1_000).default(100),
  maxDepth: z.number().int().min(1).max(30).default(6),
  minSamplesLeaf: z.number().int().min(1).max(100).default(5),
});

const boostingHyperparamsSchema = z.strictObject({
  nEstimators: z.number().int().min(10).max(1_000).default(100),
  learningRate: z.number().finite().positive().max(1).default(0.1),
  maxDepth: z.number().int().min(1).max(10).default(3),
});

export const mlModelPlanSchema = z.strictObject({
  protocolVersion: z.literal('1.0'),
  /** 白名单模型类型 */
  modelType: mlModelTypeSchema,
  /** 训练特征清单：必须引用 factorPlan 中已配置的因子 id */
  features: z.array(z.string().trim().min(1).max(128)).min(1).max(32),
  /** 未来收益标签窗口（交易日），与 compositeRunner entryOpen/exitClose 口径一致 */
  labelHorizonDays: z.number().int().min(1).max(250),
  /** 训练截止日（含）；此日期之后的行只预测不训练 */
  trainedThrough: dateSchema,
  /** 验证起始日：训练权重不得读取验证期数据 */
  validationStartsAt: dateSchema.optional(),
  /** 固定随机种子，保证跨进程可复现 */
  seed: z.number().int().min(0).max(2_147_483_647),
  /** 模型产物 SHA-256（训练后落盘校验） */
  artifactHash: hashSchema.optional(),
  hyperparameters: z.discriminatedUnion('modelType', [
    z.strictObject({ modelType: z.literal('ridge'), ...ridgeHyperparamsSchema.shape }),
    z.strictObject({ modelType: z.literal('random_forest'), ...forestHyperparamsSchema.shape }),
    z.strictObject({ modelType: z.literal('gradient_boosting'), ...boostingHyperparamsSchema.shape }),
  ]),
}).superRefine((value, context) => {
  if (value.validationStartsAt && value.trainedThrough >= value.validationStartsAt) {
    context.addIssue({ code: 'custom', path: ['trainedThrough'], message: 'TRAINING_END_MUST_PRECEDE_VALIDATION_START' });
  }
});

export const modelScoreRowSchema = z.strictObject({
  decisionDate: dateSchema,
  instrumentKey: instrumentKeySchema,
  score: z.number().finite(),
});

export const modelTrainingRowSchema = z.strictObject({
  decisionDate: dateSchema,
  instrumentKey: instrumentKeySchema,
  /** 特征值（缺失为 null，由 worker 按白名单策略处理） */
  features: z.record(z.string(), z.number().finite().nullable()),
  /** 未来收益标签（仅训练段需要；预测段可为 null） */
  label: z.number().finite().nullable(),
});

export const modelWorkerRequestSchema = z.strictObject({
  protocolVersion: z.literal('1.0'),
  spec: mlModelPlanSchema,
  rows: z.array(modelTrainingRowSchema).min(1).max(2_000_000),
});

export const modelWorkerResponseSchema = z.strictObject({
  protocolVersion: z.literal('1.0'),
  modelType: mlModelTypeSchema,
  /** 与输入行一一对应的模型分数 */
  scores: z.array(modelScoreRowSchema).min(1).max(2_000_000),
  /** 模型产物摘要（SHA-256 + 字节数） */
  artifact: z.strictObject({
    sha256: hashSchema,
    byteSize: z.number().int().nonnegative(),
  }),
});

export type MlModelPlan = z.infer<typeof mlModelPlanSchema>;
export type MlModelType = z.infer<typeof mlModelTypeSchema>;
export type ModelTrainingRow = z.infer<typeof modelTrainingRowSchema>;
export type ModelScoreRow = z.infer<typeof modelScoreRowSchema>;
export type ModelWorkerRequest = z.infer<typeof modelWorkerRequestSchema>;
export type ModelWorkerResponse = z.infer<typeof modelWorkerResponseSchema>;
