import { calculateSMA } from '@/features/indicators/sma';
import type { StrategyDefinition } from '../types';

interface DualMaParams {
  shortPeriod: number;
  longPeriod: number;
}

export const dualMaStrategy: StrategyDefinition<DualMaParams> = {
  id: 'dualMa',
  name: '双均线交叉',
  version: '1.0.0',
  description: '短期均线上穿长期均线买入，下穿卖出',
  paramsSchema: [
    {
      name: 'shortPeriod',
      label: '短期均线周期',
      type: 'number',
      defaultValue: 5,
      min: 2,
      max: 500,
      step: 1,
      description: '快速均线的计算周期',
    },
    {
      name: 'longPeriod',
      label: '长期均线周期',
      type: 'number',
      defaultValue: 20,
      min: 2,
      max: 500,
      step: 1,
      description: '慢速均线的计算周期',
    },
  ],
  defaultParams: {
    shortPeriod: 5,
    longPeriod: 20,
  },

  warmupBars(params) {
    return Math.max(params.shortPeriod, params.longPeriod);
  },

  evaluate(context, params) {
    const { index, candles, position } = context;
    const { shortPeriod, longPeriod } = params;

    if (index < longPeriod - 1) {
      return { time: candles[index].time, action: 'hold', reason: '预热期' };
    }

    if (index < 1) {
      return { time: candles[index].time, action: 'hold', reason: '数据不足' };
    }

    const shortSma = calculateSMA(candles.slice(0, index + 1), { period: shortPeriod });
    const longSma = calculateSMA(candles.slice(0, index + 1), { period: longPeriod });

    const currShort = shortSma[index];
    const prevShort = shortSma[index - 1];
    const currLong = longSma[index];
    const prevLong = longSma[index - 1];

    if (currShort == null || currLong == null || prevShort == null || prevLong == null) {
      return { time: candles[index].time, action: 'hold', reason: '指标计算中' };
    }

    // Golden cross: short crosses above long
    if (prevShort <= prevLong && currShort > currLong) {
      if (position.quantity > 0) {
        return { time: candles[index].time, action: 'hold', reason: '已持仓，忽略买入信号' };
      }
      return { time: candles[index].time, action: 'buy', reason: `短期均线上穿长期均线 (${currShort.toFixed(2)} > ${currLong.toFixed(2)})`, strength: currShort - currLong };
    }

    // Dead cross: short crosses below long
    if (prevShort >= prevLong && currShort < currLong) {
      if (position.quantity === 0) {
        return { time: candles[index].time, action: 'hold', reason: '无持仓，忽略卖出信号' };
      }
      return { time: candles[index].time, action: 'sell', reason: `短期均线下穿长期均线 (${currShort.toFixed(2)} < ${currLong.toFixed(2)})`, strength: currLong - currShort };
    }

    return { time: candles[index].time, action: 'hold', reason: '' };
  },
};
