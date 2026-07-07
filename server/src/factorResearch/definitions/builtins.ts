import type { FactorDefinition } from './schema.js';

export const BUILTIN_FACTORS: FactorDefinition[] = [
  {
    id: 'momentum_20',
    name: '20 日动量',
    description: '收盘价相对 20 个交易日前收盘价的涨跌幅。',
    direction: 'higher-is-better',
    dependencies: ['close'],
    warmupDays: 20,
    expression: { type: 'builtin', id: 'momentum_20' },
  },
  {
    id: 'reversal_5',
    name: '5 日反转',
    description: '5 日涨幅取反，用于观察短期反转效应。',
    direction: 'higher-is-better',
    dependencies: ['close'],
    warmupDays: 5,
    expression: { type: 'builtin', id: 'reversal_5' },
  },
  {
    id: 'volatility_20',
    name: '20 日波动率',
    description: '20 日收盘价变异系数，衡量近期波动强度。',
    direction: 'research',
    dependencies: ['close'],
    warmupDays: 20,
    expression: { type: 'builtin', id: 'volatility_20' },
  },
  {
    id: 'turnover_20',
    name: '20 日平均换手',
    description: '近 20 日换手率均值。',
    direction: 'research',
    dependencies: ['turnoverRatePct'],
    warmupDays: 20,
    expression: { type: 'builtin', id: 'turnover_20' },
  },
  {
    id: 'amount_20',
    name: '20 日平均成交额',
    description: '近 20 日成交额均值，用于观察流动性。',
    direction: 'higher-is-better',
    dependencies: ['amount'],
    warmupDays: 20,
    expression: { type: 'builtin', id: 'amount_20' },
  },
  {
    id: 'ma_deviation_20',
    name: '20 日均线偏离',
    description: '收盘价相对 20 日均线的偏离幅度。',
    direction: 'research',
    dependencies: ['close'],
    warmupDays: 20,
    expression: { type: 'builtin', id: 'ma_deviation_20' },
  },
  {
    id: 'boll_position_20',
    name: 'BOLL 20 位置',
    description: '收盘价相对 20 日均线和两倍标准差的位置。',
    direction: 'research',
    dependencies: ['close'],
    warmupDays: 20,
    expression: { type: 'builtin', id: 'boll_position_20' },
  },
  {
    id: 'atr_14',
    name: 'ATR 14',
    description: '近 14 日真实波幅均值。',
    direction: 'research',
    dependencies: ['high', 'low', 'previousClose'],
    warmupDays: 14,
    expression: { type: 'builtin', id: 'atr_14' },
  },
];

const BUILTIN_BY_ID = new Map(BUILTIN_FACTORS.map((factor) => [factor.id, factor]));

export function getBuiltinFactor(id: string): FactorDefinition | null {
  return BUILTIN_BY_ID.get(id) ?? null;
}
