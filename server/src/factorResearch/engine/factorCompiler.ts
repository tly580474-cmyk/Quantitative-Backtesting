import type { FactorDefinition } from '../definitions/schema.js';

export function compileBuiltinFactorSql(factor: FactorDefinition): string {
  switch (factor.id) {
    case 'momentum_20':
      return 'close / NULLIF(LAG(close, 20) OVER instrument_window, 0) - 1';
    case 'reversal_5':
      return '-1 * (close / NULLIF(LAG(close, 5) OVER instrument_window, 0) - 1)';
    case 'volatility_20':
      return 'STDDEV_SAMP(close) OVER trailing_20 / NULLIF(AVG(close) OVER trailing_20, 0)';
    case 'turnover_20':
      return 'AVG(turnoverRatePct) OVER trailing_20';
    case 'amount_20':
      return 'AVG(amount) OVER trailing_20';
    case 'ma_deviation_20':
      return 'close / NULLIF(AVG(close) OVER trailing_20, 0) - 1';
    case 'boll_position_20':
      return '(close - AVG(close) OVER trailing_20) / NULLIF(2 * STDDEV_SAMP(close) OVER trailing_20, 0)';
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
    default:
      throw new Error(`不支持的内置因子：${factor.id}`);
  }
}

export function factorDirectionMultiplier(factor: FactorDefinition): number {
  return factor.direction === 'lower-is-better' ? -1 : 1;
}
