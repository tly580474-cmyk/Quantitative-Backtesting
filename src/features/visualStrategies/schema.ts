import * as z from 'zod';
import type { ConditionRule, RuleGroup, Operand } from './types';

// ---- Operand schemas ----

const marketFieldSchema = z.enum(['open', 'high', 'low', 'close', 'volume']);

const marketOperandSchema = z.object({
  type: z.literal('market'),
  field: marketFieldSchema,
  offset: z.number().int(),
});

const indicatorOperandSchema = z.object({
  type: z.literal('indicator'),
  nodeId: z.string().min(1),
  output: z.string().min(1),
  offset: z.number().int(),
});

const accountFieldSchema = z.enum(['hasPosition', 'holdingDays', 'unrealizedPnlPercent']);

const accountOperandSchema = z.object({
  type: z.literal('account'),
  field: accountFieldSchema,
});

const parameterOperandSchema = z.object({
  type: z.literal('parameter'),
  name: z.string().min(1),
});

const literalOperandSchema = z.object({
  type: z.literal('literal'),
  value: z.union([z.number(), z.boolean()]),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const operandSchema: z.ZodType<Operand> = z.discriminatedUnion('type', [
  marketOperandSchema as any,
  indicatorOperandSchema as any,
  accountOperandSchema as any,
  parameterOperandSchema as any,
  literalOperandSchema as any,
] as const);

// ---- Comparison operator ----

const compareOperatorSchema = z.enum([
  'gt', 'gte', 'lt', 'lte', 'eq',
  'crossesAbove', 'crossesBelow',
  'between',
]);

// ---- Condition & group (recursive) ----

const conditionRuleSchema = z.object({
  type: z.literal('condition'),
  id: z.string().min(1),
  left: operandSchema,
  operator: compareOperatorSchema,
  right: operandSchema,
  upper: operandSchema.optional(),
}) satisfies z.ZodType<ConditionRule>;

const baseGroupSchema = z.object({
  type: z.literal('group'),
  id: z.string().min(1),
  operator: z.enum(['all', 'any', 'not']),
  children: z.array(z.lazy(() => ruleConditionSchema)),
});

const ruleGroupSchema: z.ZodType<RuleGroup> = baseGroupSchema as z.ZodType<RuleGroup>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ruleConditionSchema: z.ZodType<ConditionRule | RuleGroup> = z.discriminatedUnion('type', [
  conditionRuleSchema as any,
  ruleGroupSchema as any,
]);

// ---- Indicator node ----

const indicatorOutputRefSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  type: z.literal('number'),
});

const indicatorNodeSchema = z.object({
  id: z.string().min(1),
  indicatorId: z.string().min(1),
  params: z.record(z.string(), z.number()),
  outputs: z.array(indicatorOutputRefSchema),
});

// ---- Strategy parameter ----

const strategyParameterSchema = z.object({
  name: z.string().min(1),
  label: z.string().min(1),
  type: z.enum(['number', 'boolean']),
  defaultValue: z.union([z.number(), z.boolean()]),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().optional(),
  description: z.string().optional(),
});

// ---- Risk rules ----

const riskRuleSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('stopLoss'),
    value: z.number().positive(),
  }),
  z.object({
    type: z.literal('takeProfit'),
    value: z.number().positive(),
  }),
  z.object({
    type: z.literal('maxHoldingDays'),
    value: z.number().int().positive(),
  }),
]);

// ---- Metadata ----

const strategyMetadataSchema = z.object({
  source: z.enum(['visual', 'ai', 'imported']),
  createdAt: z.string(),
  updatedAt: z.string(),
  aiGenerationId: z.string().optional(),
});

// ---- Top-level document ----

export const visualStrategyDocumentSchema = z.object({
  schemaVersion: z.literal('1.0'),
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  strategyVersion: z.number().int().positive(),
  parameters: z.array(strategyParameterSchema),
  indicators: z.array(indicatorNodeSchema),
  entry: ruleGroupSchema,
  exit: ruleGroupSchema,
  risk: z.array(riskRuleSchema),
  metadata: strategyMetadataSchema,
});

export type VisualStrategyDocumentParsed = z.infer<typeof visualStrategyDocumentSchema>;

// ---- JSON Schema export (for AI server) ----

export function getDSLJsonSchema(): object {
  return z.toJSONSchema(visualStrategyDocumentSchema);
}
