import { BUILTIN_FACTORS, getBuiltinFactor } from './builtins.js';
import type { CompositeFactorRunConfig, FactorDefinition, FactorRunConfig } from './schema.js';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function listBuiltinFactors(): FactorDefinition[] {
  return BUILTIN_FACTORS.map((factor) => ({ ...factor }));
}

export function requireBuiltinFactor(id: string): FactorDefinition {
  const factor = getBuiltinFactor(id);
  if (!factor) {
    throw new Error(`不支持的内置因子：${id}`);
  }
  if (factor.expression.type !== 'builtin' || factor.expression.id !== factor.id) {
    throw new Error(`内置因子 ${id} 表达式未通过白名单校验`);
  }
  return factor;
}

export function validateFactorRunConfig(input: FactorRunConfig): FactorRunConfig {
  requireBuiltinFactor(input.factorId);
  if (!DATE_PATTERN.test(input.startDate) || !DATE_PATTERN.test(input.endDate)) {
    throw new Error('研究区间必须使用 YYYY-MM-DD 日期');
  }
  if (input.startDate > input.endDate) throw new Error('研究开始日期不能晚于结束日期');
  if (!Number.isInteger(input.horizonDays) || input.horizonDays < 1 || input.horizonDays > 60) {
    throw new Error('未来收益持有期必须是 1～60 个交易日');
  }
  if (!Number.isInteger(input.layers) || input.layers < 2 || input.layers > 20) {
    throw new Error('分层数量必须是 2～20');
  }
  if (input.minDailyAmount !== undefined && input.minDailyAmount < 0) {
    throw new Error('成交额过滤阈值不能为负数');
  }
  return {
    ...input,
    markets: normalizeList(input.markets),
    symbols: normalizeList(input.symbols),
  };
}

export function validateCompositeFactorRunConfig(
  input: CompositeFactorRunConfig,
): CompositeFactorRunConfig {
  const factorIds = [...new Set(input.factorIds.map((item) => item.trim()).filter(Boolean))];
  if (factorIds.length < 2 || factorIds.length > 12) {
    throw new Error('多因子研究需要 2～12 个因子');
  }
  for (const factorId of factorIds) requireBuiltinFactor(factorId);
  if (!['equal', 'ic', 'rankIc', 'manual'].includes(input.weighting)) {
    throw new Error('多因子权重方式仅支持 equal、ic、rankIc 和 manual');
  }
  const manualWeights = input.weighting === 'manual'
    ? validateManualWeights(factorIds, input.manualWeights)
    : undefined;
  const base = validateFactorRunConfig({
    factorId: factorIds[0],
    startDate: input.startDate,
    endDate: input.endDate,
    horizonDays: input.horizonDays,
    layers: input.layers,
    markets: input.markets,
    symbols: input.symbols,
    minDailyAmount: input.minDailyAmount,
  });
  if (
    input.validationStartDate !== undefined
    && (!DATE_PATTERN.test(input.validationStartDate)
      || input.validationStartDate <= base.startDate
      || input.validationStartDate > base.endDate)
  ) {
    throw new Error('验证区间开始日期必须位于研究开始日期之后且不晚于结束日期');
  }
  return {
    ...input,
    factorIds,
    startDate: base.startDate,
    endDate: base.endDate,
    validationStartDate: input.validationStartDate,
    horizonDays: base.horizonDays,
    layers: base.layers,
    weighting: input.weighting,
    manualWeights,
    markets: base.markets,
    symbols: base.symbols,
    minDailyAmount: base.minDailyAmount,
  };
}

function normalizeList(value: string[] | undefined): string[] | undefined {
  const normalized = [...new Set((value ?? []).map((item) => item.trim()).filter(Boolean))];
  return normalized.length ? normalized : undefined;
}

function validateManualWeights(
  factorIds: string[],
  weights: Record<string, number> | undefined,
): Record<string, number> {
  if (!weights) throw new Error('手动权重必须提供 manualWeights');
  const normalized: Record<string, number> = {};
  for (const factorId of factorIds) {
    const weight = Number(weights[factorId]);
    if (!Number.isFinite(weight)) throw new Error(`手动权重缺少因子 ${factorId}`);
    normalized[factorId] = weight;
  }
  const extra = Object.keys(weights).filter((factorId) => !factorIds.includes(factorId));
  if (extra.length) throw new Error(`手动权重包含未知因子：${extra.join(',')}`);
  if (Object.values(normalized).every((weight) => weight === 0)) {
    throw new Error('手动权重不能全部为 0');
  }
  return normalized;
}
