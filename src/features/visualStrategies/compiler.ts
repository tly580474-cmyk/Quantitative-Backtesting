import type { Candle, StrategyDefinition, StrategyParamDef, StrategySignal, StrategyContext } from '@/models';
import type {
  VisualStrategyDocument,
  Operand,
  ConditionRule,
  RuleGroup,
  IndicatorNode,
  ConditionTrace,
} from './types';
import { validateDocument } from './validator';

// ---- Indicator calculation dispatch ----
// Maps indicator IDs to their calculator functions. We import them
// directly so the compiled evaluate() runs synchronously.

import { calculateSMA, type SmaParams } from '@/features/indicators/sma';
import { calculateEMA, type EmaParams } from '@/features/indicators/ema';
import { calculateBOLL, type BollParams } from '@/features/indicators/boll';
import { calculateMACD, type MacdParams } from '@/features/indicators/macd';
import { calculateRSI, type RsiParams } from '@/features/indicators/rsi';
import { calculateKDJ, type KdjParams } from '@/features/indicators/kdj';
import { calculateATR, type AtrParams } from '@/features/indicators/atr';
import { calculateCCI, type CciParams } from '@/features/indicators/cci';
import { calculateWR, type WrParams } from '@/features/indicators/wr';
import { calculateOBV } from '@/features/indicators/obv';
import { calculateVolumeMA, type VolumeMaParams } from '@/features/indicators/volumeMa';

type IndicatorSeriesMap = Record<string, readonly (number | null)[]>;

function calculateNodeIndicators(
  node: IndicatorNode,
  candles: readonly Candle[],
): IndicatorSeriesMap {
  const { indicatorId, params, outputs } = node;
  const result: IndicatorSeriesMap = {};

  try {
    switch (indicatorId) {
      case 'sma': {
        const periods: number[] = [];
        for (let i = 1; i <= 8; i++) {
          const p = params[`period${i}`] ?? (i === 1 ? (params.period ?? 5) : 0);
          if (p >= 2) periods.push(p);
        }
        for (let i = 0; i < periods.length; i++) {
          const values = calculateSMA(candles as Candle[], { period: periods[i] });
          result[`sma${i + 1}`] = values;
        }
        break;
      }
      case 'ema': {
        const periods: number[] = [];
        for (let i = 1; i <= 8; i++) {
          const p = params[`period${i}`] ?? (i === 1 ? (params.period ?? 5) : 0);
          if (p >= 2) periods.push(p);
        }
        for (let i = 0; i < periods.length; i++) {
          const values = calculateEMA(candles as Candle[], { period: periods[i] });
          result[`ema${i + 1}`] = values;
        }
        break;
      }
      case 'boll': {
        const r = calculateBOLL(candles as Candle[], {
          period: params.period ?? 20,
          stdDev: params.stdDev ?? 2,
        });
        if (r.upper) result.upper = r.upper;
        if (r.middle) result.middle = r.middle;
        if (r.lower) result.lower = r.lower;
        break;
      }
      case 'macd': {
        const r = calculateMACD(candles as Candle[], {
          fast: params.fast ?? 12,
          slow: params.slow ?? 26,
          signal: params.signal ?? 9,
        });
        if (r.dif) result.dif = r.dif;
        if (r.dea) result.dea = r.dea;
        if (r.histogram) result.histogram = r.histogram;
        break;
      }
      case 'rsi': {
        result.rsi = calculateRSI(candles as Candle[], {
          period: params.period ?? 14,
        });
        break;
      }
      case 'kdj': {
        const r = calculateKDJ(candles as Candle[], {
          n: params.n ?? 9,
          m1: params.m1 ?? 3,
          m2: params.m2 ?? 3,
        });
        if (r.k) result.k = r.k;
        if (r.d) result.d = r.d;
        if (r.j) result.j = r.j;
        break;
      }
      case 'atr': {
        result.atr = calculateATR(candles as Candle[], {
          period: params.period ?? 14,
        });
        break;
      }
      case 'cci': {
        result.cci = calculateCCI(candles as Candle[], {
          period: params.period ?? 20,
        });
        break;
      }
      case 'wr': {
        result.wr = calculateWR(candles as Candle[], {
          period: params.period ?? 10,
        });
        break;
      }
      case 'obv': {
        const values = calculateOBV(candles as Candle[]);
        result.obv = values;
        break;
      }
      case 'volumeMa': {
        result.volumeMa = calculateVolumeMA(candles as Candle[], {
          period: params.period ?? 20,
        });
        break;
      }
    }
  } catch {
    // Calculation failed — return empty result
  }

  return result;
}

// ---- Compilation ----

export interface CompileResult {
  strategy: StrategyDefinition;
  document: VisualStrategyDocument;
}

/**
 * Compile a VisualStrategyDocument into a StrategyDefinition that the
 * backtest engine can execute.
 *
 * The returned evaluate() function is pure data-driven logic — no eval(),
 * no new Function(), no code generation.
 */
export function compileToStrategyDefinition(
  document: VisualStrategyDocument,
): StrategyDefinition {
  const indicatorNodes = document.indicators;

  const paramsSchema: StrategyParamDef[] = document.parameters.map((p) => ({
    name: p.name,
    label: p.label,
    type: p.type === 'boolean' ? 'boolean' : 'number',
    defaultValue: p.defaultValue,
    min: p.min,
    max: p.max,
    step: p.step,
    description: p.description,
  }));

  const defaultParams: Record<string, number | boolean | string> = {};
  for (const p of document.parameters) {
    defaultParams[p.name] = p.defaultValue;
  }

  function computeWarmupBars(): number {
    let maxWarmup = 0;
    for (const node of indicatorNodes) {
      const periods = Object.values(node.params).filter(
        (v): v is number => typeof v === 'number' && v >= 2,
      );
      const max = periods.length > 0 ? Math.max(...periods) : 0;
      if (max > maxWarmup) maxWarmup = max;
    }
    return maxWarmup + 1; // +1 for cross operators that need previous bar
  }

  const warmupBars = computeWarmupBars();

  // ---- Cache for indicator calculations ----
  // Keyed by candle array length. As evaluate() is called per bar with
  // growing slices, the last call has the longest array. We cache by
  // length so each bar's indicators are calculated only once.
  const indicatorCache = new Map<number, Record<string, IndicatorSeriesMap>>();

  function evaluate(context: StrategyContext, params: Record<string, number | boolean | string>): StrategySignal {
    const { index, candles, position } = context;

    // ---- Step 0: Check index bounds ----
    if (index < warmupBars - 1) {
      return { time: candles[index].time, action: 'hold', reason: '预热期' };
    }

    // ---- Step 1: Calculate all indicators (cached by candle count) ----
    const cacheKey = candles.length;
    let allIndicatorValues = indicatorCache.get(cacheKey);
    if (!allIndicatorValues) {
      allIndicatorValues = {};
      for (const node of indicatorNodes) {
        allIndicatorValues[node.id] = calculateNodeIndicators(node, candles);
      }
      // Keep only the most recent cache entry to limit memory
      indicatorCache.clear();
      indicatorCache.set(cacheKey, allIndicatorValues);
    }

    // ---- Step 2: Build resolved params map ----
    const resolvedParams: Record<string, number | boolean> = {};
    for (const p of document.parameters) {
      resolvedParams[p.name] = (params[p.name] ?? p.defaultValue) as number | boolean;
    }

    // ---- Step 3: Check risk rules FIRST (priority over exit conditions) ----
    if (position.quantity > 0) {
      // Compute holding days from entry time
      let holdingDays = 0;
      if (position.entryTime) {
        const entryDate = new Date(position.entryTime);
        const currentDate = new Date(candles[index].time);
        holdingDays = Math.floor((currentDate.getTime() - entryDate.getTime()) / (1000 * 60 * 60 * 24));
      }

      // Inject account state into resolved params for operand resolution
      resolvedParams._hasPosition = true;
      resolvedParams._holdingDays = holdingDays;
      resolvedParams._unrealizedPnlPercent = position.avgCost > 0
        ? ((candles[index].close - position.avgCost) / position.avgCost) * 100
        : 0;

      const riskSignal = checkRiskRules(document.risk, context, resolvedParams, position);
      if (riskSignal) return riskSignal;
    }

    // ---- Step 4: Evaluate exit conditions (after risk rules) ----
    const exitResult = evaluateGroup(document.exit, context, allIndicatorValues, resolvedParams, document);
    if (exitResult.match && position.quantity > 0) {
      return {
        time: candles[index].time,
        action: 'sell',
        reason: exitResult.reason || '卖出条件满足',
      };
    }

    // ---- Step 5: Evaluate entry conditions ----
    const entryResult = evaluateGroup(document.entry, context, allIndicatorValues, resolvedParams, document);
    if (entryResult.match) {
      if (position.quantity > 0) {
        return {
          time: candles[index].time,
          action: 'hold',
          reason: '已持仓，忽略买入信号',
        };
      }
      return {
        time: candles[index].time,
        action: 'buy',
        reason: entryResult.reason || '买入条件满足',
        strength: entryResult.strength,
      };
    }

    return { time: candles[index].time, action: 'hold', reason: '' };
  }

  return {
    id: document.id,
    name: document.name,
    version: String(document.strategyVersion),
    description: document.description,
    paramsSchema,
    defaultParams,
    warmupBars: () => warmupBars,
    evaluate,
  };
}

// ---- Internal: resolve operand value ----

function resolveOperand(
  op: Operand,
  index: number,
  candles: readonly Candle[],
  indicatorValues: Record<string, IndicatorSeriesMap>,
  resolvedParams: Record<string, number | boolean>,
): number | boolean | null {
  const targetIdx = 'offset' in op && typeof op.offset === 'number'
    ? index + op.offset
    : index;

  switch (op.type) {
    case 'market': {
      if (targetIdx < 0 || targetIdx >= candles.length) return null;
      return candles[targetIdx][op.field] as number;
    }
    case 'indicator': {
      const nodeValues = indicatorValues[op.nodeId];
      if (!nodeValues) return null;
      const series = nodeValues[op.output];
      if (!series) return null;
      if (targetIdx < 0 || targetIdx >= series.length) return null;
      return series[targetIdx];
    }
    case 'account': {
      switch (op.field) {
        case 'hasPosition':
          // Estimate from holding days or position state
          // For simplicity: we know from context
          return resolvedParams._hasPosition as boolean ?? false;
        case 'holdingDays':
          return resolvedParams._holdingDays as number ?? 0;
        case 'unrealizedPnlPercent':
          return resolvedParams._unrealizedPnlPercent as number ?? 0;
      }
    }
    case 'parameter': {
      return resolvedParams[op.name] ?? null;
    }
    case 'literal': {
      return op.value;
    }
  }
}

// ---- Internal: evaluate condition ----

interface EvalResult {
  match: boolean;
  reason?: string;
  strength?: number;
}

function evaluateCondition(
  cond: ConditionRule,
  context: StrategyContext,
  indicatorValues: Record<string, IndicatorSeriesMap>,
  resolvedParams: Record<string, number | boolean>,
  _document: VisualStrategyDocument,
): EvalResult {
  const { index, candles, position } = context;

  // Inject account state into resolved params for operand resolution
  resolvedParams._hasPosition = position.quantity > 0;
  resolvedParams._unrealizedPnlPercent = position.quantity > 0 && position.avgCost > 0
    ? ((candles[index].close - position.avgCost) / position.avgCost) * 100
    : 0;
  // Compute holding days from entry time
  if (position.entryTime) {
    const entryDate = new Date(position.entryTime);
    const currentDate = new Date(candles[index].time);
    resolvedParams._holdingDays = Math.floor(
      (currentDate.getTime() - entryDate.getTime()) / (1000 * 60 * 60 * 24),
    );
  } else {
    resolvedParams._holdingDays = 0;
  }

  const leftVal = resolveOperand(cond.left, index, candles, indicatorValues, resolvedParams);
  const rightVal = resolveOperand(cond.right, index, candles, indicatorValues, resolvedParams);

  if (leftVal == null || rightVal == null) {
    return { match: false, reason: '数据不足' };
  }

  if (typeof leftVal === 'boolean' || typeof rightVal === 'boolean') {
    // Boolean comparison — only eq
    if (cond.operator === 'eq') {
      const m = leftVal === rightVal;
      return { match: m, reason: m ? '布尔条件满足' : undefined };
    }
    return { match: false, reason: '布尔类型不支持该操作符' };
  }

  const l = leftVal as number;
  const r = rightVal as number;

  switch (cond.operator) {
    case 'gt':
      return { match: l > r, reason: l > r ? `${l.toFixed(4)} > ${r.toFixed(4)}` : undefined };
    case 'gte':
      return { match: l >= r, reason: l >= r ? `${l.toFixed(4)} >= ${r.toFixed(4)}` : undefined };
    case 'lt':
      return { match: l < r, reason: l < r ? `${l.toFixed(4)} < ${r.toFixed(4)}` : undefined };
    case 'lte':
      return { match: l <= r, reason: l <= r ? `${l.toFixed(4)} <= ${r.toFixed(4)}` : undefined };
    case 'eq': {
      const epsilon = 0.0001;
      const m = Math.abs(l - r) < epsilon;
      return { match: m, reason: m ? `${l.toFixed(4)} ≈ ${r.toFixed(4)}` : undefined };
    }
    case 'crossesAbove': {
      if (index < 1) return { match: false, reason: '数据不足，无法判断上穿' };
      const prevL = resolveOperand(cond.left, index - 1, candles, indicatorValues, resolvedParams) as number | null;
      const prevR = resolveOperand(cond.right, index - 1, candles, indicatorValues, resolvedParams) as number | null;
      if (prevL == null || prevR == null) return { match: false, reason: '前一值无效' };
      const match = prevL <= prevR && l > r;
      return {
        match,
        reason: match ? `上穿: ${prevL.toFixed(4)}→${l.toFixed(4)} vs ${prevR.toFixed(4)}→${r.toFixed(4)}` : undefined,
        strength: match ? l - r : undefined,
      };
    }
    case 'crossesBelow': {
      if (index < 1) return { match: false, reason: '数据不足，无法判断下穿' };
      const prevL = resolveOperand(cond.left, index - 1, candles, indicatorValues, resolvedParams) as number | null;
      const prevR = resolveOperand(cond.right, index - 1, candles, indicatorValues, resolvedParams) as number | null;
      if (prevL == null || prevR == null) return { match: false, reason: '前一值无效' };
      const match = prevL >= prevR && l < r;
      return {
        match,
        reason: match ? `下穿: ${prevL.toFixed(4)}→${l.toFixed(4)} vs ${prevR.toFixed(4)}→${r.toFixed(4)}` : undefined,
        strength: match ? r - l : undefined,
      };
    }
    case 'between': {
      if (!cond.upper) return { match: false, reason: '缺少上界' };
      const upperVal = resolveOperand(cond.upper, index, candles, indicatorValues, resolvedParams) as number | null;
      if (upperVal == null) return { match: false, reason: '上界无效' };
      const lower = Math.min(r, upperVal);
      const upper = Math.max(r, upperVal);
      const match = l >= lower && l <= upper;
      return {
        match,
        reason: match ? `${l.toFixed(4)} 在 [${lower.toFixed(4)}, ${upper.toFixed(4)}] 之间` : undefined,
      };
    }
  }
}

// ---- Internal: evaluate rule group ----

function evaluateGroup(
  group: RuleGroup,
  context: StrategyContext,
  indicatorValues: Record<string, IndicatorSeriesMap>,
  resolvedParams: Record<string, number | boolean>,
  document: VisualStrategyDocument,
): EvalResult {
  if (group.children.length === 0) {
    return { match: false, reason: '空规则组' };
  }

  const childResults: EvalResult[] = [];
  for (const child of group.children) {
    if (child.type === 'condition') {
      childResults.push(
        evaluateCondition(child, context, indicatorValues, resolvedParams, document),
      );
    } else {
      childResults.push(
        evaluateGroup(child, context, indicatorValues, resolvedParams, document),
      );
    }
  }

  switch (group.operator) {
    case 'all': {
      const allMatch = childResults.every((r) => r.match);
      if (allMatch) {
        const reasons = childResults
          .filter((r) => r.reason)
          .map((r) => r.reason!)
          .join(' 且 ');
        return { match: true, reason: reasons || '全部条件满足' };
      }
      return { match: false };
    }
    case 'any': {
      const matching = childResults.find((r) => r.match);
      if (matching) {
        return { match: true, reason: matching.reason || '至少一个条件满足' };
      }
      return { match: false };
    }
    case 'not': {
      const allMatch = childResults.every((r) => r.match);
      if (!allMatch) {
        return { match: true, reason: '反向条件满足' };
      }
      return { match: false };
    }
  }
}

// ---- Internal: risk rule check ----

function checkRiskRules(
  rules: import('./types').RiskRule[],
  context: StrategyContext,
  resolvedParams: Record<string, number | boolean>,
  position: import('@/models').PositionSnapshot,
): StrategySignal | null {
  const { index, candles } = context;

  for (const rule of rules) {
    switch (rule.type) {
      case 'stopLoss': {
        if (position.avgCost > 0) {
          const pnlPercent = ((candles[index].close - position.avgCost) / position.avgCost) * 100;
          if (pnlPercent <= -rule.value) {
            return {
              time: candles[index].time,
              action: 'sell',
              reason: `止损 ${rule.value}%（亏损 ${Math.abs(pnlPercent).toFixed(2)}%）`,
            };
          }
        }
        break;
      }
      case 'takeProfit': {
        if (position.avgCost > 0) {
          const pnlPercent = ((candles[index].close - position.avgCost) / position.avgCost) * 100;
          if (pnlPercent >= rule.value) {
            return {
              time: candles[index].time,
              action: 'sell',
              reason: `止盈 ${rule.value}%（盈利 ${pnlPercent.toFixed(2)}%）`,
            };
          }
        }
        break;
      }
      case 'maxHoldingDays': {
        const holdingDays = resolvedParams._holdingDays as number ?? 0;
        if (holdingDays >= rule.value) {
          return {
            time: candles[index].time,
            action: 'sell',
            reason: `持仓天数 ${holdingDays} 达到上限 ${rule.value} 天`,
          };
        }
        break;
      }
    }
  }

  return null;
}

// ---- Public API ----

/**
 * Validate and compile a document. Returns errors if validation fails.
 */
export function compileAndValidate(
  document: unknown,
): { success: true; strategy: StrategyDefinition; document: VisualStrategyDocument } | { success: false; errors: string[] } {
  const validation = validateDocument(document);
  if (!validation.valid) {
    return {
      success: false,
      errors: validation.errors.map((e) => `${e.path}: ${e.message}`),
    };
  }

  const doc = document as VisualStrategyDocument;
  const strategy = compileToStrategyDefinition(doc);
  return { success: true, strategy, document: doc };
}
