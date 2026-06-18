import { calculateMACD } from '@/features/indicators/macd';
import type { StrategyDefinition } from '../types';

interface MacdStrategyParams {
  fast: number;
  slow: number;
  signal: number;
}

export const macdStrategy: StrategyDefinition<MacdStrategyParams> = {
  id: 'macd',
  name: 'MACD 金叉死叉',
  version: '1.0.0',
  description: 'DIF 上穿 DEA 买入，DIF 下穿 DEA 卖出',
  paramsSchema: [
    {
      name: 'fast',
      label: '快线周期',
      type: 'number',
      defaultValue: 12,
      min: 2,
      max: 500,
      step: 1,
    },
    {
      name: 'slow',
      label: '慢线周期',
      type: 'number',
      defaultValue: 26,
      min: 2,
      max: 500,
      step: 1,
    },
    {
      name: 'signal',
      label: '信号线周期',
      type: 'number',
      defaultValue: 9,
      min: 2,
      max: 500,
      step: 1,
    },
  ],
  defaultParams: {
    fast: 12,
    slow: 26,
    signal: 9,
  },

  warmupBars(params) {
    return params.slow + params.signal - 1;
  },

  evaluate(context, params) {
    const { index, candles, position } = context;
    const { fast, slow, signal } = params;

    if (index < params.slow + params.signal - 1) {
      return { time: candles[index].time, action: 'hold', reason: '预热期' };
    }

    if (index < 1) {
      return { time: candles[index].time, action: 'hold', reason: '数据不足' };
    }

    const { dif, dea } = calculateMACD(candles.slice(0, index + 1), { fast, slow, signal });

    const currDif = dif[index];
    const prevDif = dif[index - 1];
    const currDea = dea[index];
    const prevDea = dea[index - 1];

    if (currDif == null || currDea == null || prevDif == null || prevDea == null) {
      return { time: candles[index].time, action: 'hold', reason: '指标计算中' };
    }

    // Golden cross: DIF crosses above DEA
    if (prevDif <= prevDea && currDif > currDea) {
      if (position.quantity > 0) {
        return { time: candles[index].time, action: 'hold', reason: '已持仓，忽略买入信号' };
      }
      return { time: candles[index].time, action: 'buy', reason: `DIF 上穿 DEA (${currDif.toFixed(4)} > ${currDea.toFixed(4)})`, strength: currDif - currDea };
    }

    // Dead cross: DIF crosses below DEA
    if (prevDif >= prevDea && currDif < currDea) {
      if (position.quantity === 0) {
        return { time: candles[index].time, action: 'hold', reason: '无持仓，忽略卖出信号' };
      }
      return { time: candles[index].time, action: 'sell', reason: `DIF 下穿 DEA (${currDif.toFixed(4)} < ${currDea.toFixed(4)})`, strength: currDea - currDif };
    }

    return { time: candles[index].time, action: 'hold', reason: '' };
  },
};
