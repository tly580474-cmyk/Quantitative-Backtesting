import type { DuckDBValue } from '@duckdb/node-api';
import { BUILTIN_FACTORS, getBuiltinFactor } from '../factorResearch/definitions/builtins.js';
import {
  compileFactorSql,
  factorDirectionMultiplier,
} from '../factorResearch/engine/factorCompiler.js';
import type { ParameterMap } from './duckdbCliSupport.js';

export type RecipeName = 'factor-screen' | 'factor-layer' | 'timeseries';

export interface RecipeBuildResult {
  sql: string;
  params: ParameterMap;
  description: string;
}

export interface RecipeOptions {
  factors: string[];
  weights: string[];
  markets: string[];
  symbols: string[];
  where: string[];
  startDate?: string;
  endDate?: string;
  date?: string;
  top?: string;
  minAmount?: string;
  horizon?: string;
  layers?: string;
  period?: string;
  rollingWindow?: string;
}

export function listRecipes(): Array<{ name: RecipeName; description: string }> {
  return [
    { name: 'factor-screen', description: '多因子滚动计算、截面标准化、加权评分和条件筛选' },
    { name: 'factor-layer', description: '按因子或多因子评分分层，统计未来收益、波动和胜率' },
    { name: 'timeseries', description: '将日线聚合为周/月/季度/年 OHLCV，并计算周期收益与滚动均线' },
  ];
}

export function listRecipeFactors() {
  return BUILTIN_FACTORS.map((factor) => ({
    id: factor.id,
    name: factor.name,
    direction: factor.direction,
    warmupDays: factor.warmupDays,
  }));
}

export function buildRecipe(name: RecipeName, options: RecipeOptions): RecipeBuildResult {
  if (name === 'timeseries') return buildTimeseriesRecipe(options);
  const factorContext = buildFactorContext(options);
  return name === 'factor-screen'
    ? buildFactorScreenRecipe(options, factorContext)
    : buildFactorLayerRecipe(options, factorContext);
}

function buildFactorContext(options: RecipeOptions) {
  const factorIds = [...new Set(options.factors.length > 0 ? options.factors : ['momentum_20'])];
  const factors = factorIds.map((id) => {
    const factor = getBuiltinFactor(id);
    if (!factor) throw new Error(`recipe 不支持因子：${id}，可使用 recipes --factors 查看`);
    return factor;
  });
  const weightMap = parseWeights(options.weights);
  for (const factorId of weightMap.keys()) {
    if (!factorIds.includes(factorId)) {
      throw new Error(`weight 指定了未启用的因子：${factorId}`);
    }
  }
  const maxWarmup = Math.max(...factors.map((factor) => factor.warmupDays));
  const params: ParameterMap = {};
  const conditions = buildUniverseConditions(options, params);
  const factorColumns = factors.map((factor) =>
    `${compileFactorSql(factor)} AS factor_${safeIdentifier(factor.id)}`);
  const zscoreColumns = factors.map((factor) => {
    const column = `factor_${safeIdentifier(factor.id)}`;
    return `(${column} - AVG(${column}) OVER (PARTITION BY tradeDate))
      / NULLIF(STDDEV_SAMP(${column}) OVER (PARTITION BY tradeDate), 0) AS z_${safeIdentifier(factor.id)}`;
  });
  const scoreTerms = factors.map((factor) => {
    const weight = weightMap.get(factor.id) ?? 1;
    return `${sqlNumber(weight * factorDirectionMultiplier(factor))} * COALESCE(z_${safeIdentifier(factor.id)}, 0)`;
  });
  return {
    factors,
    maxWarmup,
    params,
    conditions,
    factorColumns,
    zscoreColumns,
    compositeScore: scoreTerms.join(' + '),
  };
}

function buildFactorScreenRecipe(
  options: RecipeOptions,
  context: ReturnType<typeof buildFactorContext>,
): RecipeBuildResult {
  const top = parseInteger(options.top, 'top', 1, 100000, 100);
  context.params.limit = top;
  const scoreConditions = [];
  if (options.minAmount !== undefined) {
    context.params.minAmount = parseNumber(options.minAmount, 'min-amount', 0);
    scoreConditions.push('amount >= $minAmount');
  }
  scoreConditions.push(...options.where.map(validateWhereClause));
  if (options.date) {
    context.params.targetDate = options.date;
    scoreConditions.push('tradeDate = $targetDate');
  } else {
    scoreConditions.push('tradeDate = (SELECT MAX(tradeDate) FROM scored_rows)');
  }
  return {
    params: context.params,
    description: `多因子筛选：${context.factors.map((factor) => factor.id).join(', ')}`,
    sql: `
      ${factorCtes(options, context, undefined, true)}
      SELECT tradeDate, market, symbol, name, close, amount, turnoverRatePct,
             ${context.factors.map((factor) => `factor_${safeIdentifier(factor.id)}, z_${safeIdentifier(factor.id)}`).join(', ')},
             compositeScore,
             PERCENT_RANK() OVER (PARTITION BY tradeDate ORDER BY compositeScore) AS scorePercentile
      FROM scored_rows
      WHERE ${scoreConditions.length > 0 ? scoreConditions.join(' AND ') : 'TRUE'}
      ORDER BY compositeScore DESC NULLS LAST, amount DESC NULLS LAST
      LIMIT $limit
    `,
  };
}

function buildFactorLayerRecipe(
  options: RecipeOptions,
  context: ReturnType<typeof buildFactorContext>,
): RecipeBuildResult {
  const horizon = parseInteger(options.horizon, 'horizon', 1, 60, 5);
  const layers = parseInteger(options.layers, 'layers', 2, 20, 5);
  context.params.layers = layers;
  const extraConditions = options.where.map(validateWhereClause);
  if (options.minAmount !== undefined) {
    context.params.minAmount = parseNumber(options.minAmount, 'min-amount', 0);
    extraConditions.push('amount >= $minAmount');
  }
  return {
    params: context.params,
    description: `因子分层：${context.factors.map((factor) => factor.id).join(', ')}，持有 ${horizon} 日`,
    sql: `
      ${factorCtes(options, context, horizon)},
      eligible AS (
        SELECT *,
               exitClose / NULLIF(entryOpen, 0) - 1 AS futureReturn
        FROM scored_rows
        WHERE entryOpen > 0 AND exitClose > 0
          ${extraConditions.length ? `AND ${extraConditions.join(' AND ')}` : ''}
      ),
      layered AS (
        SELECT *,
               NTILE($layers) OVER (PARTITION BY tradeDate ORDER BY compositeScore) AS layer
        FROM eligible
      )
      SELECT layer,
             COUNT(*) AS samples,
             COUNT(DISTINCT tradeDate) AS tradingDates,
             AVG(futureReturn) AS averageReturn,
             MEDIAN(futureReturn) AS medianReturn,
             STDDEV_SAMP(futureReturn) AS returnVolatility,
             AVG(CASE WHEN futureReturn > 0 THEN 1.0 ELSE 0.0 END) AS winRate,
             MIN(futureReturn) AS worstReturn,
             MAX(futureReturn) AS bestReturn
      FROM layered
      GROUP BY layer
      ORDER BY layer
    `,
  };
}

function factorCtes(
  options: RecipeOptions,
  context: ReturnType<typeof buildFactorContext>,
  horizon?: number,
  latestOnly = false,
): string {
  const dateConditions = [...context.conditions];
  if (options.endDate) {
    context.params.endDate = options.endDate;
    dateConditions.push('tradeDate <= $endDate');
  }
  if (options.startDate) {
    context.params.startDate = options.startDate;
    context.params.warmupDays = Math.max(7, context.maxWarmup * 2);
    dateConditions.push("tradeDate >= CAST($startDate AS DATE) - CAST($warmupDays AS INTEGER) * INTERVAL 1 DAY");
  } else if (latestOnly) {
    context.params.warmupDays = Math.max(7, context.maxWarmup * 2);
    if (options.date) {
      context.params.targetDate = options.date;
      dateConditions.push("tradeDate >= CAST($targetDate AS DATE) - CAST($warmupDays AS INTEGER) * INTERVAL 1 DAY");
      dateConditions.push('tradeDate <= $targetDate');
    } else if (options.endDate) {
      dateConditions.push("tradeDate >= CAST($endDate AS DATE) - CAST($warmupDays AS INTEGER) * INTERVAL 1 DAY");
    } else {
      dateConditions.push(
        'tradeDate >= (SELECT MAX(tradeDate) FROM bars) - CAST($warmupDays AS INTEGER) * INTERVAL 1 DAY',
      );
    }
  }
  const outputDateConditions = [];
  if (options.startDate) outputDateConditions.push('tradeDate >= $startDate');
  if (options.endDate) outputDateConditions.push('tradeDate <= $endDate');
  const futureColumns = horizon
    ? `, LEAD(open, 1) OVER instrument_window AS entryOpen,
         LEAD(close, ${horizon}) OVER instrument_window AS exitClose`
    : '';
  return `
    WITH factor_values AS (
      SELECT instrumentKey, market, symbol, name, industry, tradeDate,
             open, high, low, close, previousClose, volume, amount,
             turnoverRatePct, totalMarketCap, floatMarketCap, peTtm, pb, psTtm,
             ${context.factorColumns.join(',\n             ')}
             ${futureColumns}
      FROM bars
      WHERE ${dateConditions.length ? dateConditions.join(' AND ') : 'TRUE'}
      WINDOW
        instrument_window AS (PARTITION BY instrumentKey ORDER BY tradeDate),
        trailing_5 AS (PARTITION BY instrumentKey ORDER BY tradeDate ROWS BETWEEN 4 PRECEDING AND CURRENT ROW),
        trailing_10 AS (PARTITION BY instrumentKey ORDER BY tradeDate ROWS BETWEEN 9 PRECEDING AND CURRENT ROW),
        trailing_12 AS (PARTITION BY instrumentKey ORDER BY tradeDate ROWS BETWEEN 11 PRECEDING AND CURRENT ROW),
        trailing_14 AS (PARTITION BY instrumentKey ORDER BY tradeDate ROWS BETWEEN 13 PRECEDING AND CURRENT ROW),
        trailing_20 AS (PARTITION BY instrumentKey ORDER BY tradeDate ROWS BETWEEN 19 PRECEDING AND CURRENT ROW),
        trailing_28 AS (PARTITION BY instrumentKey ORDER BY tradeDate ROWS BETWEEN 27 PRECEDING AND CURRENT ROW),
        trailing_60 AS (PARTITION BY instrumentKey ORDER BY tradeDate ROWS BETWEEN 59 PRECEDING AND CURRENT ROW)
    ),
    standardized AS (
      SELECT *,
             ${context.zscoreColumns.join(',\n             ')}
      FROM factor_values
      ${outputDateConditions.length ? `WHERE ${outputDateConditions.join(' AND ')}` : ''}
    ),
    scored_rows AS (
      SELECT *, ${context.compositeScore} AS compositeScore
      FROM standardized
    )
  `;
}

function buildTimeseriesRecipe(options: RecipeOptions): RecipeBuildResult {
  const period = options.period ?? 'month';
  if (!['week', 'month', 'quarter', 'year'].includes(period)) {
    throw new Error('period 仅支持 week、month、quarter、year');
  }
  const rollingWindow = parseInteger(options.rollingWindow, 'rolling-window', 1, 252, 6);
  const params: ParameterMap = {};
  const conditions = buildUniverseConditions(options, params);
  if (options.startDate) {
    params.startDate = options.startDate;
    conditions.push('tradeDate >= $startDate');
  }
  if (options.endDate) {
    params.endDate = options.endDate;
    conditions.push('tradeDate <= $endDate');
  }
  return {
    params,
    description: `${period} 周期 OHLCV 聚合`,
    sql: `
      WITH aggregated AS (
        SELECT instrumentKey, market, symbol, name,
               DATE_TRUNC('${period}', tradeDate) AS periodStart,
               FIRST(open ORDER BY tradeDate) AS open,
               MAX(high) AS high,
               MIN(low) AS low,
               LAST(close ORDER BY tradeDate) AS close,
               SUM(volume) AS volume,
               SUM(amount) AS amount,
               AVG(turnoverRatePct) AS averageTurnoverRatePct,
               COUNT(*) AS tradingDays
        FROM bars
        WHERE ${conditions.length ? conditions.join(' AND ') : 'TRUE'}
        GROUP BY instrumentKey, market, symbol, name, periodStart
      ),
      metrics AS (
        SELECT *,
               close / NULLIF(LAG(close) OVER instrument_window, 0) - 1 AS periodReturn,
               AVG(close) OVER (
                 PARTITION BY instrumentKey ORDER BY periodStart
                 ROWS BETWEEN ${rollingWindow - 1} PRECEDING AND CURRENT ROW
               ) AS rollingAverageClose
        FROM aggregated
        WINDOW instrument_window AS (PARTITION BY instrumentKey ORDER BY periodStart)
      )
      SELECT *
      FROM metrics
      ORDER BY periodStart, instrumentKey
    `,
  };
}

function buildUniverseConditions(
  options: RecipeOptions,
  params: ParameterMap,
): string[] {
  const conditions: string[] = [];
  addListCondition('market', options.markets, 'market', params, conditions);
  addListCondition('symbol', options.symbols, 'symbol', params, conditions);
  return conditions;
}

function addListCondition(
  field: string,
  values: string[],
  prefix: string,
  params: ParameterMap,
  conditions: string[],
): void {
  if (values.length === 0) return;
  const placeholders = values.map((value, index) => {
    const key = `${prefix}${index}`;
    params[key] = value;
    return `$${key}`;
  });
  conditions.push(`${field} IN (${placeholders.join(', ')})`);
}

function parseWeights(assignments: string[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const assignment of assignments) {
    const separator = assignment.indexOf('=');
    if (separator <= 0) throw new Error(`weight 格式无效：${assignment}`);
    const id = assignment.slice(0, separator);
    const value = Number(assignment.slice(separator + 1));
    if (!Number.isFinite(value)) throw new Error(`weight 数值无效：${assignment}`);
    result.set(id, value);
  }
  return result;
}

function validateWhereClause(value: string): string {
  if (!value.trim()) throw new Error('where 条件不能为空');
  if (value.includes(';') || /--|\/\*/.test(value)) {
    throw new Error('where 条件不能包含分号或 SQL 注释');
  }
  return `(${value})`;
}

function parseInteger(
  value: string | undefined,
  label: string,
  min: number,
  max: number,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label} 必须是 ${min} 到 ${max} 的整数`);
  }
  return parsed;
}

function parseNumber(value: string, label: string, min: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min) throw new Error(`${label} 必须是不小于 ${min} 的数字`);
  return parsed;
}

function safeIdentifier(value: string): string {
  return value.replace(/[^A-Za-z0-9_]/g, '_');
}

function sqlNumber(value: number): string {
  if (!Number.isFinite(value)) throw new Error('权重必须是有限数');
  return Number.isInteger(value) ? `${value}.0` : String(value);
}
