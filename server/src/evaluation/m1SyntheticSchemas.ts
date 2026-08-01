import { z } from 'zod';

export const m1CategorySchema = z.enum([
  'complete',
  'partial',
  'short_colloquial',
  'conflicting',
  'unsupported',
]);

export type M1Category = z.infer<typeof m1CategorySchema>;

const jsonValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.unknown()),
  z.record(z.string(), z.unknown()),
]);

const factValueSchema = z.union([
  z.string().min(1),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.unknown()).min(1),
  z.record(z.string(), z.unknown()).refine((value) => Object.keys(value).length > 0, '事实对象不得为空'),
]);

const optionalNonEmptyString = z.preprocess(
  (value) => value === '' || value === null ? undefined : value,
  z.string().min(1).optional(),
);

export const m1FactSchema = z.object({
  path: z.string().min(1),
  semanticType: z.enum([
    'indicator_parameter',
    'entry_condition',
    'exit_condition',
    'risk_rule',
    'experiment_config',
    'explicit_user_fact',
  ]),
  operator: optionalNonEmptyString,
  value: factValueSchema,
  unit: optionalNonEmptyString,
  evidenceQuote: z.string().min(1),
});

export const m1SyntheticCandidateSchema = z.object({
  sourceText: z.string().min(2).max(1000),
  category: m1CategorySchema,
  expectedDisposition: z.enum(['structured', 'needs_clarification', 'unsupported']),
  extractedFacts: z.array(m1FactSchema),
  assumptions: z.array(z.object({
    field: z.string().min(1),
    value: jsonValueSchema,
    basis: z.enum(['system_constraint', 'explicit_default']),
    reason: z.string().min(1),
  })),
  clarifications: z.array(z.object({
    field: z.string().min(1),
    reason: z.string().min(1),
    options: z.array(z.string().min(1)).max(5).optional(),
  })),
  unsupportedCapabilities: z.array(z.string().min(1)),
  prohibitedInferences: z.array(z.string().min(1)),
  tags: z.array(z.string().min(1)).min(1),
}).superRefine((candidate, ctx) => {
  if (candidate.expectedDisposition === 'structured' && candidate.extractedFacts.length === 0) {
    ctx.addIssue({ code: 'custom', path: ['extractedFacts'], message: 'structured 样本必须包含至少一个显式事实' });
  }
  if (candidate.expectedDisposition === 'needs_clarification' && candidate.clarifications.length === 0) {
    ctx.addIssue({ code: 'custom', path: ['clarifications'], message: 'needs_clarification 样本必须包含澄清问题' });
  }
  if (candidate.expectedDisposition === 'unsupported' && candidate.unsupportedCapabilities.length === 0) {
    ctx.addIssue({ code: 'custom', path: ['unsupportedCapabilities'], message: 'unsupported 样本必须说明能力缺口' });
  }
  const expectedByCategory: Record<M1Category, typeof candidate.expectedDisposition> = {
    complete: 'structured',
    partial: 'needs_clarification',
    short_colloquial: 'needs_clarification',
    conflicting: 'needs_clarification',
    unsupported: 'unsupported',
  };
  if (candidate.expectedDisposition !== expectedByCategory[candidate.category]) {
    ctx.addIssue({
      code: 'custom',
      path: ['expectedDisposition'],
      message: `${candidate.category} 样本必须标记为 ${expectedByCategory[candidate.category]}`,
    });
  }
  if (candidate.category === 'complete') {
    const types = new Set(candidate.extractedFacts.map((fact) => fact.semanticType));
    if (!types.has('entry_condition') || !types.has('exit_condition')) {
      ctx.addIssue({ code: 'custom', path: ['extractedFacts'], message: 'complete 样本必须同时包含买入和卖出事实' });
    }
  }
  candidate.extractedFacts.forEach((fact, index) => {
    if (!candidate.sourceText.includes(fact.evidenceQuote)) {
      ctx.addIssue({
        code: 'custom',
        path: ['extractedFacts', index, 'evidenceQuote'],
        message: 'evidenceQuote 必须是 sourceText 的连续原文片段',
      });
    }
  });
});

export type M1SyntheticCandidate = z.infer<typeof m1SyntheticCandidateSchema>;

export const m1CandidateBatchSchema = z.object({
  samples: z.array(m1SyntheticCandidateSchema).min(1).max(25),
});

export const m1JudgeScoreSchema = z.object({
  accuracy: z.number().int().min(1).max(5),
  evidenceGrounding: z.number().int().min(1).max(5),
  ambiguityHandling: z.number().int().min(1).max(5),
  capabilityCompliance: z.number().int().min(1).max(5),
  diversityNaturalness: z.number().int().min(1).max(5),
});

export const m1JudgeResultSchema = z.object({
  id: z.string().min(1),
  scores: m1JudgeScoreSchema,
  violations: z.array(z.string().min(1)),
  reason: z.string().min(1),
});

export type M1JudgeResult = z.infer<typeof m1JudgeResultSchema>;

export const m1JudgeBatchSchema = z.object({
  results: z.array(m1JudgeResultSchema).min(1).max(25),
});

export function judgePassed(result: M1JudgeResult): boolean {
  return result.violations.length === 0
    && Object.values(result.scores).every((score) => score >= 4);
}

export function acceptanceStatus(
  judgeB: M1JudgeResult,
  judgeC: M1JudgeResult,
): 'accepted' | 'rejected' {
  return judgePassed(judgeB) && judgePassed(judgeC) ? 'accepted' : 'rejected';
}

const CATEGORY_WEIGHTS: Record<M1Category, number> = {
  complete: 70,
  partial: 50,
  short_colloquial: 25,
  conflicting: 25,
  unsupported: 30,
};

export function allocateCategoryTargets(total: number): Record<M1Category, number> {
  if (!Number.isInteger(total) || total <= 0) throw new Error('target 必须是正整数');
  const categories = m1CategorySchema.options;
  const raw = categories.map((category) => ({
    category,
    exact: total * CATEGORY_WEIGHTS[category] / 200,
  }));
  const result = Object.fromEntries(
    raw.map(({ category, exact }) => [category, Math.floor(exact)]),
  ) as Record<M1Category, number>;
  let remaining = total - Object.values(result).reduce((sum, value) => sum + value, 0);
  for (const item of [...raw].sort((a, b) => (b.exact % 1) - (a.exact % 1))) {
    if (remaining === 0) break;
    result[item.category] += 1;
    remaining -= 1;
  }
  return result;
}
