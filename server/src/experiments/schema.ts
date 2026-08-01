import { createHash } from 'node:crypto';
import { z } from 'zod';
import { strategyDocumentSchema } from '../services/strategyGeneration/schema.js';

const confirmationSchema = z.object({
  sourceText: z.string().min(1),
  extractedFields: z.array(z.object({
    key: z.string().min(1),
    label: z.string().min(1),
    value: z.string().min(1),
    evidencePath: z.string().min(1),
  })),
  assumptions: z.array(z.object({
    id: z.string().min(1),
    label: z.string().min(1),
    selectedValue: z.string().min(1),
    options: z.array(z.string().min(1)).min(1),
    reason: z.string().min(1),
    required: z.boolean(),
    confirmed: z.boolean(),
  })),
}).superRefine((value, ctx) => {
  value.assumptions.forEach((assumption, index) => {
    if (assumption.required && !assumption.confirmed) {
      ctx.addIssue({
        code: 'custom',
        path: ['assumptions', index, 'confirmed'],
        message: '必选假设尚未确认',
      });
    }
  });
});

export const experimentSpecSchema = z.object({
  schemaVersion: z.literal('1.0'),
  market: z.object({
    assetClass: z.literal('cn_stock'),
    frequency: z.literal('1d'),
  }),
  universe: z.object({
    type: z.literal('single'),
    binding: z.literal('runtime_dataset'),
  }),
  signal: z.object({
    type: z.literal('visual_strategy'),
    document: strategyDocumentSchema,
  }),
  execution: z.object({
    signalAt: z.literal('close'),
    fillAt: z.literal('next_open'),
  }),
});

export const confirmExperimentRequestSchema = z.object({
  generationId: z.string().min(1).optional(),
  experimentId: z.string().uuid().optional(),
  name: z.string().min(1).max(255),
  sourceText: z.string().min(1).max(10_000),
  strategy: strategyDocumentSchema,
  confirmation: confirmationSchema,
  capabilityVersion: z.string().min(1).max(64),
});

const backtestConfigSchema = z.object({
  backtestMode: z.literal('strategy'),
  initialCapital: z.number().positive(),
  tradingDays: z.number().int().nonnegative(),
  positionSizing: z.object({ type: z.literal('percent'), value: z.number().positive().max(1) }),
  commissionRate: z.number().nonnegative(),
  minimumCommission: z.number().nonnegative(),
  sellTaxRate: z.number().nonnegative(),
  slippageBps: z.number().nonnegative(),
  tradingUnitMode: z.enum(['stock', 'index']),
  minimumTradeAmount: z.number().nonnegative(),
  dca: z.object({
    amount: z.number().nonnegative(),
    frequency: z.enum(['daily', 'weekly', 'monthly']),
  }),
  execution: z.literal('next_open'),
  forceCloseAtEnd: z.boolean(),
});

export const createExperimentRunRequestSchema = z.object({
  experimentVersionId: z.string().uuid(),
  idempotencyKey: z.string().min(8).max(128),
  engineVersion: z.string().min(1).max(64),
  datasetSnapshot: z.object({
    id: z.string().min(1),
    name: z.string().optional(),
    symbol: z.string().min(1),
    startTime: z.string().min(1),
    endTime: z.string().min(1),
    checksum: z.string().min(1),
  }),
  config: backtestConfigSchema,
  strategyParams: z.record(z.string(), z.union([z.number(), z.boolean(), z.string()])),
});

export const completeExperimentRunRequestSchema = z.object({
  backtestResultId: z.string().uuid(),
  resultHash: z.string().regex(/^[a-f0-9]{64}$/),
  validation: z.object({
    compile: z.literal('passed'),
    executionTiming: z.literal('close_to_next_open'),
    goldenParityGate: z.literal('passed'),
  }),
});

export const failExperimentRunRequestSchema = z.object({
  errorCode: z.enum([
    'COMPILE_FAILED',
    'DATA_MISSING',
    'DATA_QUALITY_FAILED',
    'RESOURCE_EXCEEDED',
    'RUNTIME_FAILED',
    'INTERNAL_ERROR',
  ]),
  message: z.string().min(1).max(1000),
});

export const openLockedTestRequestSchema = z.object({
  idempotencyKey: z.string().min(8).max(128),
});

export const validateExperimentRunRequestSchema = z.object({
  perturbations: z.array(z.object({
    caseId: z.string().min(1).max(255),
    totalReturn: z.number().finite(),
  })).max(500).default([]),
  sampleResults: z.object({
    train: z.object({ totalReturn: z.number().finite() }).optional(),
    validation: z.object({ totalReturn: z.number().finite() }).optional(),
    lockedTest: z.object({ totalReturn: z.number().finite() }).optional(),
    walkForward: z.array(z.object({ totalReturn: z.number().finite() })).max(50).optional(),
  }).optional(),
});

export const enqueueExperimentArtifactRequestSchema = z.object({
  format: z.enum(['html', 'pdf']),
});

export type ExperimentSpec = z.infer<typeof experimentSpecSchema>;

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalValue(item)]),
    );
  }
  return value;
}

export function canonicalHash(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalValue(value)))
    .digest('hex');
}

export function buildSingleInstrumentSpec(
  strategy: z.infer<typeof strategyDocumentSchema>,
): ExperimentSpec {
  return {
    schemaVersion: '1.0',
    market: { assetClass: 'cn_stock', frequency: '1d' },
    universe: { type: 'single', binding: 'runtime_dataset' },
    signal: { type: 'visual_strategy', document: strategy },
    execution: { signalAt: 'close', fillAt: 'next_open' },
  };
}
