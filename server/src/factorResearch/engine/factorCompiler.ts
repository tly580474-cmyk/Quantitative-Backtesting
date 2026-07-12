import { validateAndAnalyzeFactorAst } from '../definitions/factorAst.js';
import type { FactorAstNode, FactorDefinition } from '../definitions/schema.js';

export function compileFactorSql(factor: FactorDefinition): string {
  if (factor.expression.type === 'builtin') return compileBuiltinFactorSql(factor);
  if (factor.expression.version !== 1) throw new Error(`不支持的因子 AST 版本：${factor.expression.version}`);
  const analysis = validateAndAnalyzeFactorAst(factor.expression.root);
  if (factor.warmupDays < analysis.warmupDays) {
    throw new Error(`因子预热期 ${factor.warmupDays} 小于 AST 所需 ${analysis.warmupDays}`);
  }
  const declared = new Set(factor.dependencies);
  const missing = analysis.dependencies.filter((dependency) => !declared.has(dependency));
  if (missing.length) throw new Error(`因子依赖声明缺少：${missing.join(', ')}`);
  return compileAstNode(factor.expression.root);
}

function compileAstNode(node: FactorAstNode): string {
  if (node.type === 'constant') return sqlNumber(node.value);
  if (node.type === 'terminal') {
    if (node.name === 'returns') return '(close / NULLIF(previousClose, 0) - 1)';
    if (node.name === 'vwap') return '(amount / NULLIF(volume, 0))';
    if (node.name === 'log_mktcap') return 'LN(NULLIF(totalMarketCap, 0))';
    return node.name;
  }
  if (isAnalyticOperator(node.op) && node.args.some(containsAnalyticOperator)) {
    throw new Error('当前 AST 协议不允许嵌套时间序列或截面窗口算子');
  }
  const args = node.args.map(compileAstNode);
  switch (node.op) {
    case 'add': return `(${args[0]} + ${args[1]})`;
    case 'sub': return `(${args[0]} - ${args[1]})`;
    case 'mul': return `(${args[0]} * ${args[1]})`;
    case 'div': return `(${args[0]} / CASE WHEN ABS(${args[1]}) > 1e-9 THEN ${args[1]} ELSE 1.0 END)`;
    case 'min': return `(CASE WHEN ${args[0]} IS NULL OR ${args[1]} IS NULL THEN NULL ELSE LEAST(${args[0]}, ${args[1]}) END)`;
    case 'max': return `(CASE WHEN ${args[0]} IS NULL OR ${args[1]} IS NULL THEN NULL ELSE GREATEST(${args[0]}, ${args[1]}) END)`;
    case 'neg': return `(-1 * ${args[0]})`;
    case 'abs': return `ABS(${args[0]})`;
    case 'log': return `(SIGN(${args[0]}) * LN(1 + ABS(${args[0]})))`;
    case 'sqrt': return `SQRT(ABS(${args[0]}))`;
    case 'sign': return `SIGN(${args[0]})`;
    case 'inv': return `(1 / NULLIF(${args[0]}, 0))`;
    case 'cs_rank': return `(CASE WHEN ${args[0]} IS NULL THEN NULL ELSE (RANK() OVER (PARTITION BY tradeDate ORDER BY ${args[0]} NULLS LAST) + (COUNT(${args[0]}) OVER (PARTITION BY tradeDate, ${args[0]}) - 1) / 2.0) / COUNT(${args[0]}) OVER (PARTITION BY tradeDate) END)`;
    case 'cs_zscore': return `((${args[0]}) - AVG(${args[0]}) OVER (PARTITION BY tradeDate)) / NULLIF(STDDEV_SAMP(${args[0]}) OVER (PARTITION BY tradeDate), 0)`;
    case 'cs_neutralize': {
      const yMean = `AVG(${args[0]}) OVER (PARTITION BY tradeDate)`;
      const xMean = `AVG(${args[1]}) OVER (PARTITION BY tradeDate)`;
      const beta = `COALESCE(COVAR_POP(${args[0]}, ${args[1]}) OVER (PARTITION BY tradeDate) / NULLIF(VAR_POP(${args[1]}) OVER (PARTITION BY tradeDate), 0), 0)`;
      return `((${args[0]}) - ${yMean} - (${beta}) * ((${args[1]}) - ${xMean}))`;
    }
    case 'cs_indneutral': return `((${args[0]}) - AVG(${args[0]}) OVER (PARTITION BY tradeDate, COALESCE(industry, 'UNK')))`;
    case 'ts_delay': return `LAG(${args[0]}, ${node.window}) OVER instrument_window`;
    case 'ts_delta': return `((${args[0]}) - LAG(${args[0]}, ${node.window}) OVER instrument_window)`;
    case 'ts_mean': return rolling('AVG', args[0], node.window!);
    case 'ts_std': return rolling('STDDEV_SAMP', args[0], node.window!);
    case 'ts_min': return rolling('MIN', args[0], node.window!);
    case 'ts_max': return rolling('MAX', args[0], node.window!);
    case 'ts_sum': return rolling('SUM', args[0], node.window!);
    default: throw new Error(`不支持的因子算子：${node.op}`);
  }
}

function isAnalyticOperator(op: string): boolean {
  return op.startsWith('ts_') || op.startsWith('cs_');
}

function containsAnalyticOperator(node: FactorAstNode): boolean {
  return node.type === 'operator'
    && (isAnalyticOperator(node.op) || node.args.some(containsAnalyticOperator));
}

function rolling(fn: string, expression: string, window: number): string {
  const frame = `PARTITION BY instrumentKey ORDER BY tradeDate ROWS BETWEEN ${window - 1} PRECEDING AND CURRENT ROW`;
  const minPeriods = Math.max(2, Math.floor(window * 0.6));
  return `(CASE WHEN COUNT(${expression}) OVER (${frame}) >= ${minPeriods} THEN ${fn}(${expression}) OVER (${frame}) ELSE NULL END)`;
}

function sqlNumber(value: number): string {
  if (!Number.isFinite(value)) throw new Error('因子 AST 常数必须是有限数');
  return Number.isInteger(value) ? `${value}.0` : String(value);
}

export function compileBuiltinFactorSql(factor: FactorDefinition): string {
  switch (factor.id) {
    case 'momentum_20':
      return 'close / NULLIF(LAG(close, 20) OVER instrument_window, 0) - 1';
    case 'reversal_5':
      return '-1 * (close / NULLIF(LAG(close, 5) OVER instrument_window, 0) - 1)';
    case 'roc_10':
      return 'close / NULLIF(LAG(close, 10) OVER instrument_window, 0) - 1';
    case 'roc_60':
      return 'close / NULLIF(LAG(close, 60) OVER instrument_window, 0) - 1';
    case 'volatility_20':
      return 'STDDEV_SAMP(close) OVER trailing_20 / NULLIF(AVG(close) OVER trailing_20, 0)';
    case 'volatility_60':
      return 'STDDEV_SAMP(close) OVER trailing_60 / NULLIF(AVG(close) OVER trailing_60, 0)';
    case 'turnover_20':
      return 'AVG(turnoverRatePct) OVER trailing_20';
    case 'amount_20':
      return 'AVG(amount) OVER trailing_20';
    case 'ma_deviation_20':
      return 'close / NULLIF(AVG(close) OVER trailing_20, 0) - 1';
    case 'bias_5':
      return 'close / NULLIF(AVG(close) OVER trailing_5, 0) - 1';
    case 'bias_10':
      return 'close / NULLIF(AVG(close) OVER trailing_10, 0) - 1';
    case 'bias_60':
      return 'close / NULLIF(AVG(close) OVER trailing_60, 0) - 1';
    case 'boll_position_20':
      return '(close - AVG(close) OVER trailing_20) / NULLIF(2 * STDDEV_SAMP(close) OVER trailing_20, 0)';
    case 'boll_width_20':
      return '4 * STDDEV_SAMP(close) OVER trailing_20 / NULLIF(AVG(close) OVER trailing_20, 0)';
    case 'atr_14':
      return `
        AVG(
          GREATEST(
            high - low,
            ABS(high - previousClose),
            ABS(low - previousClose)
          )
        ) OVER trailing_14
      `;
    case 'range_pct_20':
      return 'AVG((high - low) / NULLIF(close, 0)) OVER trailing_20';
    case 'range_pct_60':
      return 'AVG((high - low) / NULLIF(close, 0)) OVER trailing_60';
    case 'volume_ratio_20':
      return 'volume / NULLIF(AVG(volume) OVER trailing_20, 0)';
    case 'volume_ratio_60':
      return 'volume / NULLIF(AVG(volume) OVER trailing_60, 0)';
    case 'amihud_20':
      return 'AVG(ABS(close / NULLIF(previousClose, 0) - 1) / NULLIF(amount, 0)) OVER trailing_20';
    case 'gap_1':
      return 'open / NULLIF(previousClose, 0) - 1';
    case 'intraday_strength_1':
      return '(close - low) / NULLIF(high - low, 0)';
    case 'breakout_20':
      return 'close / NULLIF(MAX(high) OVER trailing_20, 0) - 1';
    case 'drawdown_20':
      return 'close / NULLIF(MAX(high) OVER trailing_20, 0) - 1';
    case 'max_return_20':
      return 'MAX(close / NULLIF(previousClose, 0) - 1) OVER trailing_20';
    case 'downside_volatility_20':
      return 'STDDEV_SAMP(CASE WHEN close < previousClose THEN close / NULLIF(previousClose, 0) - 1 END) OVER trailing_20';
    case 'vwap_deviation_20':
      return 'close / NULLIF(SUM(amount) OVER trailing_20 / NULLIF(SUM(volume) OVER trailing_20, 0), 0) - 1';
    case 'price_volume_corr_20':
      return 'CORR(close / NULLIF(previousClose, 0) - 1, volume) OVER trailing_20';
    case 'pvt_flow_20':
      return 'SUM((close / NULLIF(previousClose, 0) - 1) * volume) OVER trailing_20';
    case 'obv_flow_20':
      return `
        SUM(
          CASE
            WHEN close > previousClose THEN volume
            WHEN close < previousClose THEN -volume
            ELSE 0
          END
        ) OVER trailing_20
      `;
    case 'cmf_20':
      return `
        SUM(((close - low) - (high - close)) / NULLIF(high - low, 0) * volume) OVER trailing_20
        / NULLIF(SUM(volume) OVER trailing_20, 0)
      `;
    case 'mfi_14':
      return `
        100 - 100 / (
          1 + SUM(CASE WHEN close > previousClose THEN ((high + low + close) / 3) * volume ELSE 0 END) OVER trailing_14
          / NULLIF(SUM(CASE WHEN close < previousClose THEN ((high + low + close) / 3) * volume ELSE 0 END) OVER trailing_14, 0)
        )
      `;
    case 'rsi_14':
      return `
        100 - 100 / (
          1 + AVG(GREATEST(close - previousClose, 0)) OVER trailing_14
          / NULLIF(AVG(GREATEST(previousClose - close, 0)) OVER trailing_14, 0)
        )
      `;
    case 'psy_12':
      return 'AVG(CASE WHEN close > previousClose THEN 1 ELSE 0 END) OVER trailing_12';
    case 'imi_14':
      return `
        SUM(GREATEST(close - open, 0)) OVER trailing_14
        / NULLIF(
          SUM(GREATEST(close - open, 0)) OVER trailing_14
          + SUM(GREATEST(open - close, 0)) OVER trailing_14,
          0
        )
      `;
    case 'cci_20':
      return `
        (((high + low + close) / 3) - AVG((high + low + close) / 3) OVER trailing_20)
        / NULLIF(0.015 * STDDEV_SAMP((high + low + close) / 3) OVER trailing_20, 0)
      `;
    case 'vhf_28':
      return `
        (MAX(high) OVER trailing_28 - MIN(low) OVER trailing_28)
        / NULLIF(SUM(ABS(close - previousClose)) OVER trailing_28, 0)
      `;
    case 'body_ratio_1':
      return 'ABS(close - open) / NULLIF(high - low, 0)';
    case 'upper_shadow_ratio_1':
      return '(high - GREATEST(open, close)) / NULLIF(high - low, 0)';
    case 'lower_shadow_ratio_1':
      return '(LEAST(open, close) - low) / NULLIF(high - low, 0)';
    case 'stochastic_k_14':
      return '(close - MIN(low) OVER trailing_14) / NULLIF(MAX(high) OVER trailing_14 - MIN(low) OVER trailing_14, 0)';
    case 'williams_r_14':
      return '(MAX(high) OVER trailing_14 - close) / NULLIF(MAX(high) OVER trailing_14 - MIN(low) OVER trailing_14, 0)';
    default:
      throw new Error(`不支持的内置因子：${factor.id}`);
  }
}

export function factorDirectionMultiplier(factor: FactorDefinition): number {
  return factor.direction === 'lower-is-better' ? -1 : 1;
}
