import { z } from 'zod';

const operandSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('market'),
    field: z.enum(['open', 'high', 'low', 'close', 'volume']),
    offset: z.number().int().max(0),
  }),
  z.object({
    type: z.literal('indicator'),
    nodeId: z.string().min(1),
    output: z.string().min(1),
    offset: z.number().int().max(0),
  }),
  z.object({
    type: z.literal('account'),
    field: z.enum(['hasPosition', 'holdingDays', 'unrealizedPnlPercent']),
  }),
  z.object({ type: z.literal('parameter'), name: z.string().min(1) }),
  z.object({ type: z.literal('literal'), value: z.union([z.number(), z.boolean()]) }),
]);

const conditionSchema = z.object({
  type: z.literal('condition'),
  id: z.string().min(1),
  left: operandSchema,
  operator: z.enum(['gt', 'gte', 'lt', 'lte', 'eq', 'crossesAbove', 'crossesBelow', 'between']),
  right: operandSchema,
  upper: operandSchema.optional(),
});

type Rule = z.infer<typeof conditionSchema> | {
  type: 'group';
  id: string;
  operator: 'all' | 'any' | 'not';
  children: Rule[];
};

function collectParameterReferencesFromOperand(value: unknown, output: Set<string>): void {
  const input = record(value);
  if (input?.type === 'parameter' && typeof input.name === 'string') {
    output.add(input.name);
  }
}

function collectParameterReferencesFromRule(value: unknown, output: Set<string>): void {
  const input = record(value);
  if (!input) return;
  if (input.type === 'condition') {
    collectParameterReferencesFromOperand(input.left, output);
    collectParameterReferencesFromOperand(input.right, output);
    collectParameterReferencesFromOperand(input.upper, output);
    return;
  }
  if (input.type === 'group' && Array.isArray(input.children)) {
    for (const child of input.children) collectParameterReferencesFromRule(child, output);
  }
}

const ruleSchema: z.ZodType<Rule> = z.lazy(() => z.discriminatedUnion('type', [
  conditionSchema,
  z.object({
    type: z.literal('group'),
    id: z.string().min(1),
    operator: z.enum(['all', 'any', 'not']),
    children: z.array(ruleSchema).min(1),
  }),
]));

const indicatorOutputs: Record<string, Set<string>> = {
  sma: new Set(['sma1', 'sma2', 'sma3', 'sma4', 'sma5', 'sma6', 'sma7', 'sma8']),
  ema: new Set(['ema1', 'ema2', 'ema3', 'ema4', 'ema5', 'ema6', 'ema7', 'ema8']),
  boll: new Set(['upper', 'middle', 'lower']),
  macd: new Set(['dif', 'dea', 'histogram']),
  rsi: new Set(['rsi']),
  kdj: new Set(['k', 'd', 'j']),
  atr: new Set(['atr']),
  cci: new Set(['cci']),
  wr: new Set(['wr']),
  obv: new Set(['obv']),
  volumeMa: new Set(['volumeMa']),
  bias: new Set(['bias']),
  volatility: new Set(['volatility', 'annualVolatility']),
  volCluster: new Set(['volCluster']),
  hold: new Set(['holdReturn', 'holdNav']),
  reversal: new Set(['reversal']),
};

export const strategyDocumentSchema = z.object({
  schemaVersion: z.literal('1.0'),
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  strategyVersion: z.number().int().positive(),
  parameters: z.array(z.object({
    name: z.string().min(1),
    label: z.string().min(1),
    type: z.enum(['number', 'boolean']),
    defaultValue: z.union([z.number(), z.boolean()]),
    min: z.number().optional(),
    max: z.number().optional(),
    step: z.number().optional(),
    description: z.string().optional(),
  })),
  indicators: z.array(z.object({
    id: z.string().min(1),
    indicatorId: z.string().min(1),
    params: z.record(z.string(), z.number()),
    outputs: z.array(z.object({
      key: z.string().min(1),
      label: z.string().min(1),
      type: z.literal('number'),
    })).min(1),
  })),
  entry: ruleSchema,
  exit: ruleSchema,
  risk: z.array(z.discriminatedUnion('type', [
    z.object({ type: z.literal('stopLoss'), value: z.number().positive().max(100) }),
    z.object({ type: z.literal('takeProfit'), value: z.number().positive().max(100) }),
    z.object({ type: z.literal('maxHoldingDays'), value: z.number().int().positive().max(3650) }),
  ])),
  metadata: z.object({
    source: z.enum(['visual', 'ai', 'imported']),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
    aiGenerationId: z.string().optional(),
  }),
}).superRefine((doc, ctx) => {
  const nodes = new Map(doc.indicators.map((node) => [node.id, node]));
  const parameterNames = new Set(doc.parameters.map((parameter) => parameter.name));
  const referencedParameterNames = new Set<string>();
  collectParameterReferencesFromRule(doc.entry, referencedParameterNames);
  collectParameterReferencesFromRule(doc.exit, referencedParameterNames);

  for (const [index, node] of doc.indicators.entries()) {
    const allowed = indicatorOutputs[node.indicatorId];
    if (!allowed) {
      ctx.addIssue({ code: 'custom', path: ['indicators', index, 'indicatorId'], message: `未知指标: ${node.indicatorId}` });
      continue;
    }
    for (const [outputIndex, output] of node.outputs.entries()) {
      if (!allowed.has(output.key)) {
        ctx.addIssue({ code: 'custom', path: ['indicators', index, 'outputs', outputIndex, 'key'], message: `指标 ${node.indicatorId} 不支持输出 ${output.key}` });
      }
    }
  }

  for (const [index, parameter] of doc.parameters.entries()) {
    if (!referencedParameterNames.has(parameter.name)) {
      ctx.addIssue({
        code: 'custom',
        path: ['parameters', index, 'name'],
        message: `策略参数 ${parameter.name} 未被 entry/exit 条件引用，不会影响交易`,
      });
    }
    if (
      parameter.type === 'number'
      && parameter.defaultValue === 0
      && /period|周期|threshold|阈值|upper|lower|上限|下限|fast|slow|signal|std|rsi|macd|boll|vol/i.test(`${parameter.name} ${parameter.label}`)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['parameters', index, 'defaultValue'],
        message: `策略参数 ${parameter.name} 的默认值疑似占位 0，请填写真实数值`,
      });
    }
  }

  const visit = (rule: Rule, path: (string | number)[]) => {
    if (rule.type === 'group') {
      rule.children.forEach((child, index) => visit(child, [...path, 'children', index]));
      return;
    }
    const operands = [rule.left, rule.right, ...(rule.upper ? [rule.upper] : [])];
    for (const [index, operand] of operands.entries()) {
      const operandPath = [...path, index === 0 ? 'left' : index === 1 ? 'right' : 'upper'];
      if (operand.type === 'indicator') {
        const node = nodes.get(operand.nodeId);
        if (!node) {
          ctx.addIssue({ code: 'custom', path: operandPath, message: `引用了未声明指标 ${operand.nodeId}` });
        } else if (!node.outputs.some((output) => output.key === operand.output)) {
          ctx.addIssue({ code: 'custom', path: operandPath, message: `指标 ${operand.nodeId} 没有输出 ${operand.output}` });
        }
      }
      if (operand.type === 'parameter' && !parameterNames.has(operand.name)) {
        ctx.addIssue({ code: 'custom', path: operandPath, message: `引用了未声明参数 ${operand.name}` });
      }
    }
    if (rule.operator === 'between' && !rule.upper) {
      ctx.addIssue({ code: 'custom', path, message: 'between 必须包含 upper' });
    }
  };

  visit(doc.entry, ['entry']);
  visit(doc.exit, ['exit']);
});

export const explanationSchema = z.object({
  explanation: z.string().min(1),
  risks: z.array(z.string()),
  parameterNotes: z.string(),
});

export type StrategyDocument = z.infer<typeof strategyDocumentSchema>;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function numeric(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return fallback;
}

function normalizeOperand(value: unknown): unknown {
  const input = record(value);
  if (!input) return value;
  if (input.type === 'market') return { ...input, offset: numeric(input.offset, 0) };
  if (input.type === 'indicator') return { ...input, offset: numeric(input.offset, 0) };
  if (input.type === 'literal') {
    const literal = input.value;
    return { ...input, value: typeof literal === 'string' && literal.trim() !== '' && Number.isFinite(Number(literal)) ? Number(literal) : literal };
  }
  return input;
}

function normalizeRule(value: unknown, fallbackId: string): unknown {
  if (Array.isArray(value)) {
    return {
      type: 'group', id: fallbackId, operator: 'all',
      children: value.map((child, index) => normalizeRule(child, `${fallbackId}_${index + 1}`)),
    };
  }
  const input = record(value);
  if (!input) return value;
  const children = input.children ?? input.conditions ?? input.rules;
  if (input.type === 'group' || Array.isArray(children)) {
    return {
      ...input,
      type: 'group',
      id: typeof input.id === 'string' && input.id ? input.id : fallbackId,
      operator: ['all', 'any', 'not'].includes(String(input.operator)) ? input.operator : 'all',
      children: Array.isArray(children)
        ? children.map((child, index) => normalizeRule(child, `${fallbackId}_${index + 1}`))
        : [],
    };
  }
  if (input.type === 'condition' || ('left' in input && 'right' in input && 'operator' in input)) {
    return {
      ...input,
      type: 'condition',
      id: typeof input.id === 'string' && input.id ? input.id : fallbackId,
      left: normalizeOperand(input.left),
      right: normalizeOperand(input.right),
      ...(input.upper === undefined ? {} : { upper: normalizeOperand(input.upper) }),
    };
  }
  return input;
}

function normalizeRisk(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value.map((item) => {
      const risk = record(item);
      return risk ? { ...risk, value: numeric(risk.value) } : item;
    });
  }
  const input = record(value);
  if (!input) return [];
  return ['stopLoss', 'takeProfit', 'maxHoldingDays']
    .filter((type) => input[type] !== undefined)
    .map((type) => {
      const nested = record(input[type]);
      return { type, value: numeric(nested?.value ?? input[type]) };
    });
}

export function normalizeStrategyCandidate(value: unknown, generationId: string): unknown {
  const input = record(value);
  if (!input) return value;
  const now = new Date().toISOString();
  const metadata = record(input.metadata) ?? {};
  const normalizedEntry = normalizeRule(input.entry, 'entry_root');
  const normalizedExit = normalizeRule(input.exit, 'exit_root');
  const referencedParameters = new Set<string>();
  collectParameterReferencesFromRule(normalizedEntry, referencedParameters);
  collectParameterReferencesFromRule(normalizedExit, referencedParameters);
  const parameters = Array.isArray(input.parameters) ? input.parameters.map((item) => {
    const parameter = record(item);
    if (!parameter) return item;
    const defaultValue = parameter.type === 'boolean'
      ? parameter.defaultValue === true || parameter.defaultValue === 'true'
      : numeric(parameter.defaultValue);
    return {
      ...parameter,
      defaultValue,
      ...(parameter.min === undefined ? {} : { min: numeric(parameter.min) }),
      ...(parameter.max === undefined ? {} : { max: numeric(parameter.max) }),
      ...(parameter.step === undefined ? {} : { step: numeric(parameter.step) }),
    };
  }).filter((item) => {
    const parameter = record(item);
    return typeof parameter?.name === 'string' && referencedParameters.has(parameter.name);
  }) : [];
  const indicators = Array.isArray(input.indicators) ? input.indicators.map((item, index) => {
    const indicator = record(item);
    if (!indicator) return item;
    const params = record(indicator.params) ?? {};
    return {
      ...indicator,
      id: typeof indicator.id === 'string' && indicator.id ? indicator.id : `indicator_${index + 1}`,
      params: Object.fromEntries(Object.entries(params).map(([key, entry]) => [key, numeric(entry)])),
      outputs: Array.isArray(indicator.outputs) ? indicator.outputs.map((output) => {
        const current = record(output);
        return current ? { ...current, type: 'number' } : output;
      }) : indicator.outputs,
    };
  }) : [];

  return {
    ...input,
    schemaVersion: '1.0',
    id: typeof input.id === 'string' && input.id ? input.id : generationId,
    description: typeof input.description === 'string' ? input.description : '',
    strategyVersion: Math.max(1, Math.trunc(numeric(input.strategyVersion, 1))),
    parameters,
    indicators,
    entry: normalizedEntry,
    exit: normalizedExit,
    risk: normalizeRisk(input.risk),
    metadata: {
      ...metadata,
      source: 'ai',
      createdAt: typeof metadata.createdAt === 'string' ? metadata.createdAt : now,
      updatedAt: now,
      aiGenerationId: generationId,
    },
  };
}

export function formatValidationErrors(error: z.ZodError): string[] {
  const messages: string[] = [];
  const collect = (issues: z.core.$ZodIssue[], parentPath: PropertyKey[] = []) => {
    for (const issue of issues) {
      const path = [...parentPath, ...issue.path];
      if (issue.code === 'invalid_union' && 'errors' in issue && issue.errors.length > 0) {
        for (const branch of issue.errors) collect(branch, path);
        continue;
      }
      messages.push(`${path.map(String).join('.') || 'root'}: ${issue.message}`);
    }
  };
  collect(error.issues);
  if (messages.length === 0) messages.push(z.prettifyError(error));
  return [...new Set(messages.filter(Boolean))];
}

export class StrategyOutputValidationError extends Error {
  constructor(public readonly validationErrors: string[]) {
    super(`模型输出不符合 Strategy DSL: ${validationErrors.join('; ')}`);
    this.name = 'StrategyOutputValidationError';
  }
}
